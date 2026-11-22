import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  albumSchemaUnion,
  albumValue,
  channelGroupIds,
  listBotGroupIds,
  mergeAlbumCandidates,
  probeGroupAlbums,
  readAlbumCache,
  writeAlbumCache,
} from '../lib/index.js';

const ALBUM_WIKI_DIR = path.resolve('tmp/albums-test');

/** 一台假 OneBot：`groups` 决定它能看到哪些群，`albums` 是群号 → 分页响应序列。 */
function fakeBot({ groups = [], albums = {}, supportsGroupList = true } = {}) {
  const calls = [];
  const internal = {
    async _get(action, params) {
      calls.push({ action, params });
      if (action === 'get_group_list') {
        if (!supportsGroupList) throw new Error('unsupported');
        return { status: 'ok', retcode: 0, data: { group_list: groups.map((id) => ({ group_id: Number(id), group_name: `群${id}` })) } };
      }
      if (action === 'get_group_info') {
        const groupId = String(params.group_id);
        if (!groups.includes(groupId)) throw new Error('not in group');
        return { status: 'ok', retcode: 0, data: { group_name: `群${groupId}` } };
      }
      if (action === 'get_qun_album_list') {
        const groupId = String(params.group_id);
        if (!groups.includes(groupId)) throw new Error('not in group');
        const pages = albums[groupId] ?? [];
        const page = params.attach_info === undefined ? 0 : Number(String(params.attach_info).replace('page-', ''));
        return pages[page];
      }
      throw new Error(`unexpected action ${action}`);
    },
  };
  return { bot: { platform: 'onebot', selfId: '1', internal }, calls };
}

function album(albumId, albumName) {
  return { album_id: albumId, name: albumName, upload_number: 0 };
}

function page(list, next) {
  return {
    status: 'ok',
    retcode: 0,
    data: {
      album_list: list,
      attach_info: next === undefined ? 'tail' : next,
      has_more: next !== undefined,
    },
  };
}

test('ALBUM-01: 投递服务优先，服务空列表时回退 bot 直查', async () => {
  const { bot } = fakeBot({ groups: ['1'], albums: { '1': [page([album('a1', '杂七杂八')])] } });
  const service = {
    async listAlbums() {
      return [];
    },
  };
  const albums = await probeGroupAlbums({ groupIds: ['1'], bots: [bot], service });
  assert.deepEqual(albums.map(albumValue), ['1/a1']);

  const preferred = await probeGroupAlbums({
    groupIds: ['1'],
    bots: [bot],
    service: { async listAlbums() { return [{ groupId: '1', groupName: '服务群', albumId: 'svc', albumName: '服务相册' }]; } },
  });
  assert.deepEqual(preferred.map(albumValue), ['1/svc'], '服务有结果时不再直查 bot');
});

test('ALBUM-02: 相册分页读取 data 内的 attach_info / has_more（SnowLuma 响应形状）', async () => {
  const { bot, calls } = fakeBot({
    groups: ['100000003'],
    albums: {
      '100000003': [
        page([album('p1', '第一页')], 'page-1'),
        page([album('p2', '第二页')], 'page-2'),
        page([album('p3', '第三页')]),
      ],
    },
  });
  const albums = await probeGroupAlbums({ groupIds: ['100000003'], bots: [bot] });
  assert.deepEqual(albums.map((item) => item.albumId), ['p1', 'p2', 'p3']);
  const listCalls = calls.filter((call) => call.action === 'get_qun_album_list');
  assert.equal(listCalls.length, 3);
  assert.equal(listCalls[1].params.attach_info, 'page-1', '第二页必须带上第一页的 attach_info');
  assert.equal(albums[0].groupName, '群100000003');
});

test('ALBUM-03: 单群本轮探测为空时保留旧候选，其它群正常覆盖', async () => {
  const previous = [
    { groupId: '1', groupName: '群1', albumId: 'old', albumName: '旧相册' },
    { groupId: '2', groupName: '群2', albumId: 'b', albumName: 'B' },
  ];
  const discovered = [{ groupId: '1', groupName: '群1', albumId: 'fresh', albumName: '新相册' }];
  const merged = mergeAlbumCandidates(previous, discovered, ['1', '2']);
  assert.deepEqual(merged.map(albumValue), ['1/fresh', '2/b']);
});

test('ALBUM-04: 不再探测的群（机器人退群）从候选中移除', async () => {
  const previous = [
    { groupId: '1', groupName: '群1', albumId: 'a', albumName: 'A' },
    { groupId: '9', groupName: '已退群', albumId: 'z', albumName: 'Z' },
  ];
  const merged = mergeAlbumCandidates(previous, [], ['1']);
  assert.deepEqual(merged.map(albumValue), ['1/a']);
});

test('ALBUM-05: 候选 union 以空值为首（新行默认不上传），保留已配置但未探测到的值', () => {
  const union = albumSchemaUnion(
    [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: 'A' }],
    ['1/a', '2/legacy'],
  );
  const values = union.list.map((item) => item.value);
  assert.deepEqual(values, ['', '1/a', '2/legacy']);
  assert.match(union.list[2].meta.description, /未探测到/u);
  assert.equal(union.list[0].meta.description, '不上传相册（留空即跳过）');

  const empty = albumSchemaUnion([], []);
  assert.equal(empty.list.length, 1);
  assert.equal(empty.list[0].value, '');
  assert.match(empty.list[0].meta.description, /尚未探测到相册/u);
});

test('ALBUM-06: 频道条目归一成群号，非 OneBot 条目丢弃', () => {
  assert.deepEqual(
    channelGroupIds(['100000000', 'onebot:100000001', 'onebot:group:100000002', ' telegram:1', 'onebot:private:2']),
    ['100000000', '100000001', '100000002'],
  );
});

test('ALBUM-07: 缓存读写往返；文件缺失或损坏返回空数组', async () => {
  await fs.rm(ALBUM_WIKI_DIR, { recursive: true, force: true });
  const cached = [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: 'A' }];
  assert.equal(await writeAlbumCache(ALBUM_WIKI_DIR, cached), true);
  assert.deepEqual(await readAlbumCache(ALBUM_WIKI_DIR), cached);

  await fs.writeFile(path.join(ALBUM_WIKI_DIR, '.patchouli', 'albums.json'), '{not json', 'utf8');
  assert.deepEqual(await readAlbumCache(ALBUM_WIKI_DIR), []);
  await fs.rm(ALBUM_WIKI_DIR, { recursive: true, force: true });
  assert.deepEqual(await readAlbumCache(ALBUM_WIKI_DIR), []);
});

test('ALBUM-08: 所在群列表从 get_group_list 的 data.group_list 读取，不受白名单限制', async () => {
  const { bot } = fakeBot({ groups: ['1', '2'], supportsGroupList: true });
  const unsupported = fakeBot({ groups: ['3'], supportsGroupList: false });
  assert.deepEqual(await listBotGroupIds([bot]), ['1', '2']);
  assert.deepEqual(await listBotGroupIds([unsupported.bot]), []);
  assert.deepEqual(await listBotGroupIds([{ platform: 'qq', internal: bot.internal }]), [], '非 onebot 平台不探测');
});

test('ALBUM-09: 隐藏 Bot（chatluna-sandbox 之类模拟实例）不参与探测，零动作调用', async () => {
  const hiddenCalls = [];
  const hidden = {
    platform: 'onebot',
    hidden: true,
    internal: {
      async _get(action) {
        hiddenCalls.push(action);
        throw new Error(`NapCat 基线不支持 OneBot action：${action}`);
      },
    },
  };
  const { bot, calls } = fakeBot({ groups: ['1'], albums: { '1': [page([album('a1', '杂七杂八')])] } });
  const albums = await probeGroupAlbums({ groupIds: ['1'], bots: [hidden, bot] });
  assert.deepEqual(albums.map(albumValue), ['1/a1']);
  assert.deepEqual(hiddenCalls, [], '隐藏 Bot 一次动作都不能被调用');
  assert.deepEqual(await listBotGroupIds([hidden]), []);
  assert.ok(calls.some((call) => call.action === 'get_qun_album_list'), '真实 Bot 照常探测');
});
