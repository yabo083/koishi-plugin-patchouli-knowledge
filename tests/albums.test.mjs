import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  MAX_CONFIGURED_TARGETS,
  albumSchemaUnion,
  albumTargetOptions,
  albumUnionItems,
  albumValue,
  buildTargetNameIndex,
  channelGroupIds,
  legacyAlbumTargetOptions,
  listBotGroupIds,
  mergeAlbumCandidates,
  probeGroupAlbums,
  readAlbumCache,
  readStartupTargetTables,
  readStartupTargetValues,
  resolveTargetBindings,
  scopeAlbumCandidates,
  subscriptionTargetsSchema,
  writeAlbumCache,
} from '../lib/index.js';
import {
  albumValueOfTarget,
  installSubscriptionTargetLabels,
  installSubscriptionTargetWarnings,
  normalizeSubscriptionRows,
  resolveTarget,
} from '../lib/plugin/subscriptions.js';

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

test('ALBUM-10: 订阅目标候选 = @chat + 各群标题 + 各相册（取值 = 唯一可读名）', () => {
  const album = { groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' };
  const union = albumSchemaUnion([album], ['群1 · 词条', '2/legacy', '@chat'], { targets: true });
  assert.deepEqual(
    union.list.map((item) => item.value),
    ['@chat', '#group:1', '词条', '群1 · 词条', '2/legacy'],
    '@chat 在首位；群标题项紧跟其后；相册项取值 = 唯一可读名；旧名与未探测值保留',
  );
  assert.equal(union.list[0].meta.description, '本群聊天（投递到该行来源群本身）');
  assert.equal(union.list[1].meta.description, '群1', '群标题项只写群名');
  assert.equal(union.list[1].meta.disabled, true, '群标题项不可选：它只是下拉里的分段标题');
  assert.equal(union.list[2].value, '词条', '相册项取值就是可读名（标签只显示 value）');
  assert.equal(union.list[2].meta.description, '词条', '文案与 value 一致');
  assert.equal(union.list[2].meta.disabled, undefined, '相册项可选');
  assert.equal(union.list[3].meta.disabled, true, '旧名保留项不可选：它只让旧配置过校验');
  assert.match(union.list[3].meta.description, /候选里对应 1\/a/u, '能唯一解析的旧名照实说保存后会绑到哪');
  assert.equal(
    union.list[4].meta.description,
    '2 的相册 legacy（未探测到：确认机器人在该群且相册已创建）',
    '未探测值也要可读：拆成「群号 的相册 相册ID」',
  );

  // yml 里还没迁移的旧稳定地址：留在候选里（否则整份配置过不了严格校验），并说明对应哪个名字。
  const legacy = albumSchemaUnion([album], ['1/a'], { targets: true });
  assert.deepEqual(legacy.list.map((item) => item.value), ['@chat', '#group:1', '词条', '1/a']);
  assert.equal(legacy.list[2].meta.description, '词条', '已探测项照常写名字');
  assert.match(legacy.list[3].meta.description, /对应「词条（1）」/u);

  // 歧义旧名（两个群都有「词条」）：裸名字不再分配给任何相册，只能重新选择。
  const ambiguous = albumSchemaUnion(
    [album, { groupId: '2', groupName: '群2', albumId: 'b', albumName: '词条' }],
    ['词条'],
    { targets: true },
  );
  assert.deepEqual(
    ambiguous.list.map((item) => item.value),
    ['@chat', '#group:1', '群1 · 词条', '#group:2', '群2 · 词条', '词条'],
    '同批重名一律加群名限定：裸名字不会被「先到先得」占走',
  );
  const stale = ambiguous.list.find((item) => item.value === '词条');
  assert.equal(stale.meta.disabled, true, '歧义旧名不可选，只能被重新选择替换');
  assert.match(stale.meta.description, /无法解析/u);

  // 目标候选不提供空串项：空数组本身就是「不投递」。
  assert.equal(union.list.some((item) => item.value === ''), false);

  const bare = albumSchemaUnion([], [], { targets: true });
  assert.deepEqual(bare.list.map((item) => item.value), ['@chat'], '没探测到相册时仍可选 @chat、没有空标题');

  // 已配置值一个都不能丢（静态 union 的校验是严格的，少一个 = 整份配置拒载）；
  // 上限只由订阅表自身的硬上限（行数 × 每行目标数）钉住，不是「留 64 个够用」。
  const many = Array.from({ length: 200 }, (_, index) => `9/x${index}`);
  const kept = albumSchemaUnion([], many, { targets: true });
  assert.equal(kept.list.length, 1 + many.length, '已配置但未探测到的取值全部进 union');
  const oversized = Array.from({ length: MAX_CONFIGURED_TARGETS + 5 }, (_, index) => `9/y${index}`);
  assert.equal(
    albumSchemaUnion([], oversized, { targets: true }).list.length,
    1 + MAX_CONFIGURED_TARGETS,
    '总长度仍被订阅表硬上限（行数 × 每行目标数）钉住',
  );
});

test('ALBUM-10b: 取值 = 唯一可读名（重名加群名、再重加群号、最后 #n；无名回退地址）', () => {
  const options = albumTargetOptions([
    { groupId: '1', groupName: '同名群', albumId: 'a', albumName: '词条' },
    { groupId: '2', groupName: '同名群', albumId: 'b', albumName: '词条' },
    { groupId: '2', groupName: '同名群', albumId: 'c', albumName: '词条' },
    { groupId: '3', groupName: '', albumId: 'x', albumName: '相册X' },
    { groupId: '4', groupName: '群4', albumId: 'y', albumName: '' },
    { groupId: '5', groupName: '  ', albumId: 'z', albumName: '  ' },
  ]);
  const albums = options.filter((option) => option.albumValue !== undefined);
  const named = new Map(albums.map((option) => [option.albumValue, option.value]));
  assert.equal(named.get('1/a'), '同名群 · 词条', '同批重名一律加群名限定（不靠先到先得）');
  assert.equal(named.get('2/b'), '同名群 · 词条（2）', '群名也重 → 再追加群号');
  assert.equal(named.get('2/c'), '同名群 · 词条（2）#2', '仍重 → #n 收尾，保证枚举内唯一');
  assert.equal(named.get('3/x'), '相册X', '本批唯一的名字就是裸相册名');
  assert.equal(named.get('4/y'), '4/y', '相册名缺失回退稳定地址');
  assert.equal(named.get('5/z'), '5/z');
  const values = [...named.values()];
  assert.equal(new Set(values).size, values.length, '取值必须唯一：它是写进配置的唯一真源');
  for (const option of albums) {
    assert.equal(option.description, option.value, '标签只显示 value，文案与取值一致才能读');
  }

  // 跨群同名（群名不同）→ 各自加群名限定，两个名字都唯一。
  const acrossGroups = albumTargetOptions([
    { groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' },
    { groupId: '2', groupName: '群2', albumId: 'b', albumName: '词条' },
  ]);
  assert.deepEqual(
    acrossGroups.filter((option) => option.albumValue !== undefined).map((option) => option.value).sort(),
    ['群1 · 词条', '群2 · 词条'],
  );

  // 相册名撞上保留值：名字必须换形态，否则 `@chat` 会被解析成群聊天。
  const reserved = albumTargetOptions([
    { groupId: '1', groupName: '群1', albumId: 'a', albumName: '@chat' },
    { groupId: '2', groupName: '群2', albumId: 'b', albumName: '#group:9' },
  ]);
  assert.deepEqual(
    reserved.filter((option) => option.albumValue !== undefined).map((option) => option.value),
    ['群1 · @chat', '群2 · #group:9'],
  );

  // 旧命名（`群名 · 相册名`）仍可构造：升级前保存的值靠它做唯一匹配。
  assert.deepEqual(
    legacyAlbumTargetOptions([
      { groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' },
      { groupId: '1', groupName: '群1', albumId: 'b', albumName: '词条' },
    ]),
    [
      { value: '群1 · 词条', albumValue: '1/a' },
      { value: '群1 · 词条（1）', albumValue: '1/b' },
    ],
  );
});

test('ALBUM-10c: 下拉按群分段——每组一条不可选标题、组内相册连续、取值不随排序漂移', () => {
  const options = albumTargetOptions([
    { groupId: '2', groupName: 'Beta群', albumId: 'b1', albumName: 'b' },
    { groupId: '1', groupName: 'Alpha群', albumId: 'a2', albumName: 'b' },
    { groupId: '2', groupName: 'Beta群', albumId: 'b2', albumName: 'a' },
    { groupId: '1', groupName: 'Alpha群', albumId: 'a1', albumName: 'a' },
  ]);
  assert.equal(options[0].value, '@chat', '@chat 恒为首项');
  assert.deepEqual(
    options.map((option) => option.value),
    ['@chat', '#group:1', 'Alpha群 · a', 'Alpha群 · b', '#group:2', 'Beta群 · a', 'Beta群 · b'],
    '按群名聚拢、组内按相册名排序；取值 = 唯一可读名（同批重名一律加群名）',
  );
  assert.deepEqual(
    options.filter((option) => option.albumValue !== undefined).map((option) => option.description),
    ['Alpha群 · a', 'Alpha群 · b', 'Beta群 · a', 'Beta群 · b'],
    '文案 = 取值：下拉标签只显示 value',
  );
  const headers = options.filter((option) => option.disabled === true);
  assert.deepEqual(
    headers.map((option) => [option.value, option.description]),
    [['#group:1', 'Alpha群'], ['#group:2', 'Beta群']],
    '群标题项：value = `#group:<群号>`，文案就是群名，且不可选',
  );

  // 分组标题不是目标：解析为空、归一阶段丢弃（脏配置不能把它当群号 / 相册）。
  assert.deepEqual(resolveTarget('#group:1'), []);
  assert.deepEqual(resolveTarget('#group:1', '100000001'), []);
  assert.deepEqual(
    normalizeSubscriptionRows([{ source: '1', targets: ['#group:1', '@chat'], entry: true, weekly: false }]),
    [{ source: '1', targets: ['@chat'], entry: true, weekly: false }],
    '归一阶段直接丢掉分组标题，别让它占掉一个目标位',
  );
});

test('ALBUM-11: 目标注册 schema 是多选标签（array(const union) + role select）', () => {
  const schema = subscriptionTargetsSchema(
    [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' }],
    [],
  );
  assert.equal(schema.type, 'array');
  assert.equal(schema.meta.role, 'select', 'SchemaMultiSelect 的注册条件：type array + role select');
  assert.deepEqual(schema.meta.default, []);
  assert.equal(schema.inner.type, 'union');
  assert.equal(
    schema.inner.list.every((item) => item.type === 'const'),
    true,
    'isMultiSelect 只认纯 const union（分组标题项也是 const，只是 meta.disabled）',
  );
  assert.deepEqual(schema.inner.list.map((item) => item.value), ['@chat', '#group:1', '词条']);
  assert.equal(schema.meta.description, '投递群（可多个）', '列头文案只有这一行，不再附多行说明');
});

test('ALBUM-12: 原地替换 union 的 const 列表后，序列化与新候选一致（重载刷新可行）', () => {
  const schema = subscriptionTargetsSchema(
    [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: '旧相册' }],
    [],
  );
  const before = JSON.stringify(schema.toJSON());
  assert.equal(before.includes('旧相册'), true);
  assert.equal(before.includes('新相册'), false);

  // 只换 `inner.list`：外层的 type / role / default 与 inner 的类型都不动。
  schema.inner.list = albumUnionItems(
    [{ groupId: '1', groupName: '群1', albumId: 'b', albumName: '新相册' }],
    ['9/legacy'],
    { targets: true },
  );
  assert.equal(schema.type, 'array');
  assert.equal(schema.meta.role, 'select');
  assert.equal(schema.inner.type, 'union');
  assert.equal(schema.inner.list.every((item) => item.type === 'const'), true, '仍是纯 const union');
  assert.equal(JSON.stringify(schema.toJSON()).includes('新相册'), true, '序列化现读 list，控制台下次拉 schema 拿到新候选');
  assert.deepEqual(schema(['新相册', '@chat']), ['新相册', '@chat'], '新候选（唯一可读名）能通过校验');
  assert.throws(() => schema(['旧相册']), '旧候选已被替换，校验必须失败（证明 list 生效）');
  assert.throws(() => schema(['1/b']), '候选的稳定地址不再写进 union（旧 yml 值靠 configured 保留）');
});

/** 造一个 Koishi 实例目录：`koishi.yml`（按行给）+ `<wikiDir>/.patchouli/albums.json`。 */
async function makeInstance(dir, yamlLines, albums, wikiDir = 'data/llmwiki') {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  if (yamlLines !== undefined) await fs.writeFile(path.join(dir, 'koishi.yml'), yamlLines.join('\n'), 'utf8');
  if (albums !== undefined) await writeAlbumCache(path.join(dir, wikiDir), albums);
}

test('ALBUM-13: 启动期候选——读实例 koishi.yml + 相册缓存（订阅表是静态 union）', async () => {
  const dir = path.resolve('tmp/startup-targets');
  await makeInstance(
    dir,
    [
      "prefix: ['.']",
      'plugins:',
      '  patchouli-knowledge:',
      '    storage:',
      '      wikiDir: data/llmwiki',
      '    subscriptions:',
      "      - source: '1'",
      "        targets: ['@chat', '1/a', '1/a']",
      "      - source: '2'",
      "        target: '3/old'",
      "      - source: '3'",
      "        targets: [' ', 42, '2/legacy']",
    ],
    [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' }],
  );

  const values = readStartupTargetValues({ baseDir: dir });
  assert.deepEqual(values.albums.map(albumValue), ['1/a'], '候选来自 `<wikiDir>/.patchouli/albums.json`');
  assert.deepEqual(
    values.configured,
    ['1/a', '3/old', '2/legacy'],
    '已配置目标 = targets ∪ 历史 target；去空白、去重、排除 @chat 与非字符串',
  );

  // 启动期候选就是表格列的 const union：@chat 在首位，紧跟该群标题项，然后是相册项
  // （取值 = 唯一可读名），已配置但尚未迁移的值（旧稳定地址 / 未探测值）排在末尾——
  // 静态 union 校验严格，不能丢。
  const schema = subscriptionTargetsSchema(values.albums, values.configured);
  assert.equal(schema.inner.type, 'union');
  assert.deepEqual(schema.inner.list.map((item) => item.value), [
    '@chat',
    '#group:1',
    '词条',
    '1/a',
    '3/old',
    '2/legacy',
  ]);
  assert.equal(schema.inner.list[2].meta.description, '词条', '相册项文案 = 取值（唯一可读名）');
  assert.match(schema.inner.list[3].meta.description, /对应「词条（1）」/u, '旧稳定地址照实说明现在叫什么');
  assert.equal(schema.inner.list.every((item) => item.type === 'const'), true);
});

test('ALBUM-14: 启动期候选——koishi.yml 缺失 / 损坏时静默降级为空，绝不抛', async () => {
  const cached = [{ groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' }];
  // 缓存存在但实例配置缺失：不去猜 wikiDir，直接空候选。
  const missing = path.resolve('tmp/startup-targets-missing');
  await makeInstance(missing, undefined, cached);
  assert.deepEqual(readStartupTargetValues({ baseDir: missing }), { albums: [], configured: [], bindings: {} });

  const broken = path.resolve('tmp/startup-targets-broken');
  await makeInstance(broken, ['plugins: [unclosed', '  - {'], cached);
  assert.deepEqual(readStartupTargetValues({ baseDir: broken }), { albums: [], configured: [], bindings: {} });

  assert.deepEqual(readStartupTargetValues({ baseDir: path.join(missing, 'no-such-dir') }), {
    albums: [],
    configured: [],
    bindings: {},
  });
});

test('ALBUM-15: 启动期候选——自定义 wikiDir、键名变体（~ 前缀 / :id 后缀 / 分组嵌套）、缺省 wikiDir', async () => {
  const custom = path.resolve('tmp/startup-targets-custom');
  await makeInstance(
    custom,
    [
      'plugins:',
      '  group:extra:',
      "    '~patchouli-knowledge:2':",
      '      storage:',
      '        wikiDir: alt/wiki',
      '      subscriptions:',
      "        - source: '*'",
      "          targets: ['5/z']",
    ],
    [{ groupId: '5', groupName: '群5', albumId: 'z', albumName: '主题' }],
    'alt/wiki',
  );
  const values = readStartupTargetValues({ baseDir: custom });
  assert.deepEqual(values.albums.map(albumValue), ['5/z'], '相册缓存按自定义 wikiDir（相对实例目录）定位');
  assert.deepEqual(values.configured, ['5/z'], '深层嵌套、带 ~ 前缀与 :id 后缀的插件键也要认');

  const fallback = path.resolve('tmp/startup-targets-fallback');
  await makeInstance(
    fallback,
    [
      'plugins:',
      '  patchouli-knowledge:',
      '    subscriptions:',
      "      - source: '*'",
      "        targets: ['@chat', '9/k']",
    ],
    [{ groupId: '9', groupName: '群9', albumId: 'k', albumName: '词条' }],
  );
  const defaults = readStartupTargetValues({ baseDir: fallback });
  assert.deepEqual(defaults.albums.map(albumValue), ['9/k'], 'storage.wikiDir 缺省 = data/llmwiki');
  assert.deepEqual(defaults.configured, ['9/k']);
});

test('ALBUM-15b: 候选路径锚定 baseDir——进程 cwd 指向别处时仍读实例目录（baseDir 为空才回退 cwd）', async () => {
  const baseDir = path.resolve('tmp/startup-targets-basedir');
  await makeInstance(
    baseDir,
    [
      'plugins:',
      '  patchouli-knowledge:',
      '    subscriptions:',
      "      - source: '7'",
      "        targets: ['7/q']",
    ],
    [{ groupId: '7', groupName: '群7', albumId: 'q', albumName: '周报' }],
  );

  // 另一个「进程目录」：故意放一份读歪就会露出马脚的配置（不同群 / 不同 wikiDir）
  const elsewhere = path.resolve('tmp/startup-targets-cwd');
  await makeInstance(
    elsewhere,
    [
      'plugins:',
      '  patchouli-knowledge:',
      '    storage:',
      '      wikiDir: other/wiki',
      '    subscriptions:',
      "      - source: '8'",
      "        targets: ['8/w']",
    ],
    [{ groupId: '8', groupName: '群8', albumId: 'w', albumName: '周报' }],
    'other/wiki',
  );

  const previous = process.cwd();
  try {
    process.chdir(elsewhere);
    const values = readStartupTargetValues({ baseDir });
    assert.deepEqual(values.albums.map(albumValue), ['7/q'], '相册缓存按 baseDir 定位，不跟进程 cwd');
    assert.deepEqual(values.configured, ['7/q'], 'koishi.yml 同样读 baseDir 里的那份');

    const viaCwd = readStartupTargetValues({ baseDir: '   ' });
    assert.deepEqual(viaCwd.albums.map(albumValue), ['8/w'], 'baseDir 为空才回退进程 cwd');
    assert.deepEqual(viaCwd.configured, ['8/w']);
  } finally {
    process.chdir(previous);
  }
});

test('ALBUM-16: 启动期辅助表——解析只认落盘绑定，候选只给展示文案', async () => {
  const dir = path.resolve('tmp/startup-target-maps');
  await makeInstance(
    dir,
    ['plugins:', '  patchouli-knowledge:', '    storage:', '      wikiDir: data/llmwiki'],
    [
      { groupId: '1', groupName: '群1', albumId: 'a', albumName: '词条' },
      { groupId: '1', groupName: '群1', albumId: 'b', albumName: '词条' },
      { groupId: '2', groupName: '', albumId: 'c', albumName: '' },
    ],
  );
  const values = readStartupTargetValues({ baseDir: dir });
  assert.deepEqual(values.bindings, {}, 'settings.json 里没有 targetBindings → 空绑定表（不是候选的反解表）');

  const tables = readStartupTargetTables(values);
  assert.deepEqual(
    [...tables.valueToName],
    [
      ['1/a', '词条（1）'],
      ['1/b', '词条（1）'],
      ['2/c', 'c（2）'],
    ],
    '日志文案表：相册名（群号）；相册无名回退相册ID，群号永远写出来（同名相册要分得清）',
  );
  assert.equal(tables.nameToValue.size, 0, '解析表只来自绑定表：没有绑定就没有可解析的名字');

  const bound = readStartupTargetTables({
    ...values,
    bindings: { '群1 · 词条': '1/a', '2/c': '2/c' },
  });
  assert.deepEqual(
    [...bound.nameToValue],
    [
      ['群1 · 词条', '1/a'],
      ['2/c', '2/c'],
    ],
    '绑定表原样照用：投递期不拿候选重算',
  );

  // union 的相册项取值就是候选分配的名字（保存时按它绑定）。
  const union = albumSchemaUnion(values.albums, [], { targets: true });
  const albumItems = union.list.filter((item) => !item.value.startsWith('#group:') && item.value !== '@chat');
  assert.deepEqual(
    albumItems.map((item) => item.value),
    ['2/c', '群1 · 词条', '群1 · 词条（1）'],
    '按群名聚拢（无名群回退群号，排在前面），组内按相册名排序',
  );
  assert.deepEqual(
    albumItems.map((item) => item.meta.description),
    ['2/c', '群1 · 词条', '群1 · 词条（1）'],
    '文案 = 取值',
  );
  assert.deepEqual(
    [...buildTargetNameIndex(values.albums)],
    [
      ['群1 · 词条', '1/a'],
      ['群1 · 词条（1）', '1/b'],
      ['2/c', '2/c'],
    ],
    '保存期索引只登记枚举内唯一的名字（裸「词条」同批重名 → 不登记），它是绑定表的来源',
  );
  const empty = readStartupTargetTables({ albums: [], configured: [], bindings: {} });
  assert.equal(empty.valueToName.size, 0, '空候选 → 空展示表');
  assert.equal(empty.nameToValue.size, 0);
});

test('ALBUM-17: 表外群的历史缓存被丢弃；configured 点名的具体相册仍保留', async () => {
  const cached = [
    { groupId: '100000001', groupName: '示例群一', albumId: 'a1', albumName: '词条' },
    { groupId: '100000002', groupName: '示例群二', albumId: 't1', albumName: '测试相册1' },
    { groupId: '100000002', groupName: '示例群二', albumId: 't2', albumName: '测试相册2' },
  ];
  // 探测范围只有示例群一：合并（scope 内掉线保留旧候选）与过滤都不得带出示例群二。
  const merged = mergeAlbumCandidates(cached, [{ groupId: '100000001', groupName: '示例群一', albumId: 'a1', albumName: '词条' }], ['100000001']);
  assert.deepEqual(merged.map(albumValue), ['100000001/a1']);
  assert.deepEqual(scopeAlbumCandidates(cached, ['100000001']).map(albumValue), ['100000001/a1'], '表外群的相册直接丢');

  // configured 例外：只保留被点名的那个相册，同群其它相册照旧丢弃。
  assert.deepEqual(
    scopeAlbumCandidates(cached, ['100000001'], ['100000002/t2']).map(albumValue),
    ['100000001/a1', '100000002/t2'],
  );
  // 旧 yml 值可能是可读名：也要能反解后命中。
  assert.deepEqual(
    scopeAlbumCandidates(cached, ['100000001'], ['示例群二 · 测试相册2']).map(albumValue),
    ['100000001/a1', '100000002/t2'],
    '旧命名命中的具体相册同样保留',
  );

  // 端到端形态：实例目录的缓存里就有表外群，候选 union 里不得出现它的其它相册。
  const dir = path.resolve('tmp/scope-cache');
  await makeInstance(
    dir,
    [
      'plugins:',
      '  patchouli-knowledge:',
      '    storage:',
      '      wikiDir: data/llmwiki',
      '    subscriptions:',
      "      - source: '100000001'",
      "        targets: ['100000002/t2']",
    ],
    cached,
  );
  const values = readStartupTargetValues({ baseDir: dir });
  assert.deepEqual(values.albums.map(albumValue), ['100000001/a1', '100000002/t1', '100000002/t2'], '缓存本身不过滤');
  const items = albumUnionItems(
    scopeAlbumCandidates(values.albums, ['100000001'], values.configured),
    values.configured,
    { targets: true },
  );
  assert.equal(items.some((item) => item.value === '测试相册1'), false, '表外群的其它相册不得进候选');
  assert.equal(items.some((item) => item.value === '100000002/t2'), true, '点名值留在候选里（静态 union 校验必须过）');
  assert.equal(items.some((item) => item.value === '词条'), true, 'scope 内的相册照常可选（取值是唯一可读名）');
  const valuesSeen = items.map((item) => item.value);
  assert.equal(new Set(valuesSeen).size, valuesSeen.length, '候选取值必须唯一');
  for (const item of items) {
    assert.ok(item.value !== '', '候选取值不能是空串（不投递用空数组表达）');
  }

  // 缓存里根本没有的旧值 → 以「未探测」条目保留。
  const missing = albumUnionItems(scopeAlbumCandidates(cached, ['100000001']), ['999/legacy'], { targets: true });
  assert.deepEqual(missing.map((item) => item.value), ['@chat', '#group:100000001', '词条', '999/legacy']);
  assert.match(missing[3].meta.description, /未探测到/u);
  await fs.rm(dir, { recursive: true, force: true });
});

test('BIND-01: 同群同名相册交换探测顺序——已保存目标的最终地址不变', () => {
  const first = { groupId: '100000001', groupName: '图书室', albumId: 'ALBUM01', albumName: '词条' };
  const second = { groupId: '100000001', groupName: '图书室', albumId: 'ALBUM02', albumName: '词条' };
  const rows = [{ source: '100000001', targets: ['图书室 · 词条'], entry: true, weekly: false }];

  // 面板保存（候选顺序 A,B）：名字 → 稳定地址写进绑定表。
  const saved = resolveTargetBindings(rows, [first, second]);
  assert.deepEqual(saved, {
    bindings: { '图书室 · 词条': '100000001/ALBUM01' },
    unresolved: [],
  });

  // 探测顺序交换：同一个名字在候选里换主——这正是「只查实时索引」会静默改投的情形。
  assert.equal(buildTargetNameIndex([second, first]).get('图书室 · 词条'), '100000001/ALBUM02');

  // 投递期只查绑定表：目标仍是保存时那个相册。
  installSubscriptionTargetLabels({ nameToValue: new Map(Object.entries(saved.bindings)) });
  try {
    assert.deepEqual(resolveTarget('图书室 · 词条'), [
      { kind: 'album', channelId: 'onebot:100000001', albumId: 'ALBUM01' },
    ]);
    assert.equal(albumValueOfTarget('图书室 · 词条'), '100000001/ALBUM01');
  } finally {
    installSubscriptionTargetLabels();
  }
});

test('BIND-02: 唯一名消失 + 新群同名相册出现——停投并 warn，绝不改投', () => {
  const gone = { groupId: '100000001', groupName: '图书室', albumId: 'ALBUM01', albumName: '词条' };
  const newcomer = { groupId: '100000002', groupName: '阅览室', albumId: 'ALBUM09', albumName: '词条' };
  const rows = [{ source: '100000001', targets: ['词条'], entry: true, weekly: false }];

  // ① 唯一名当时能解析 → 绑定到老地址。
  const saved = resolveTargetBindings(rows, [gone]);
  assert.deepEqual(saved.bindings, { 词条: '100000001/ALBUM01' });

  // 新群出现同名相册：保存期索引会把它算成「词条」（旧实现据此静默改投）。
  assert.equal(buildTargetNameIndex([newcomer]).get('词条'), '100000002/ALBUM09');

  installSubscriptionTargetLabels({ nameToValue: new Map(Object.entries(saved.bindings)) });
  const warnings = [];
  installSubscriptionTargetWarnings((message) => warnings.push(message));
  try {
    // ② 已绑定：继续投老地址，绝不追新同名相册。
    assert.deepEqual(resolveTarget('词条'), [
      { kind: 'album', channelId: 'onebot:100000001', albumId: 'ALBUM01' },
    ]);
    assert.deepEqual(warnings, [], '绑定还在时不喊「未绑定」');

    // ③ 面板再保存一次，而候选里已经没有那个相册：名字保留、绑定被丢掉 → 停投 + warn。
    //    （没有历史绑定时旧实现会直接解析到新群的同名相册——所以必须带上 previous。）
    const resaved = resolveTargetBindings(rows, [newcomer], saved.bindings);
    assert.deepEqual(resaved, { bindings: {}, unresolved: ['词条'] });
    installSubscriptionTargetLabels({ nameToValue: new Map(Object.entries(resaved.bindings)) });
    assert.deepEqual(resolveTarget('词条'), [], '未绑定即停投');
    assert.deepEqual(warnings, ['目标未绑定或相册已变更：词条，请在面板重新选择'], '不得静默改投到新群的同名相册');

    // ④ 相册还在（只是名字换了主）：绑定原样保留，多次保存也不会换收件人。
    const kept = resolveTargetBindings(rows, [gone, newcomer], { 词条: '100000001/ALBUM01' });
    assert.deepEqual(kept, { bindings: { 词条: '100000001/ALBUM01' }, unresolved: [] });
  } finally {
    installSubscriptionTargetLabels();
    installSubscriptionTargetWarnings();
  }
});

test('ALBUM-18: 相册名长得像稳定地址（2026/Spring）时加限定后缀——可绑定、不被当地址', () => {
  const album = { groupId: '2026', groupName: '', albumId: 'ALBUM01', albumName: '2026/Spring' };
  const item = albumTargetOptions([album]).find((option) => option.albumValue !== undefined);
  assert.equal(item.albumValue, '2026/ALBUM01');
  assert.equal(item.value, '2026/Spring（2026/ALBUM01）', '后缀带稳定地址：形状被破坏，且枚举内唯一');
  assert.match(item.value, /^2026\//u);
  assert.doesNotMatch(item.value, /^\d+\/[^/]+$/u, '候选值不得再匹配「群号/相册ID」');

  // 绑定能建立：地址形状的名字会被当成「已经是地址」跳过（旧实现 → 永不绑定 → 停投）。
  const rows = [{ source: '2026', targets: [item.value], entry: true, weekly: false }];
  assert.deepEqual(resolveTargetBindings(rows, [album]), {
    bindings: { [item.value]: '2026/ALBUM01' },
    unresolved: [],
  });
  assert.equal(buildTargetNameIndex([album]).get(item.value), '2026/ALBUM01', '名字索引同样指向该相册');

  // 未命名相册仍回退它自己的地址：地址天然唯一，必须可用。
  const unnamed = albumTargetOptions([
    { groupId: '7', groupName: '群7', albumId: 'x', albumName: '' },
  ]).find((option) => option.albumValue !== undefined);
  assert.equal(unnamed.value, '7/x');
});

test('BIND-03: 掉绑后重复同样的保存不再改绑；改过这一行才重新解析', () => {
  const gone = { groupId: '100', groupName: '图书室', albumId: 'a', albumName: 'Notes' };
  const newcomer = { groupId: '200', groupName: '阅览室', albumId: 'b', albumName: 'Notes' };
  const weekly = { groupId: '200', groupName: '阅览室', albumId: 'c', albumName: '周报' };
  const rows = [{ source: '100', targets: ['Notes'], entry: true, weekly: false }];

  // ① 相册还在 → 绑定。
  const first = resolveTargetBindings(rows, [gone]);
  assert.deepEqual(first, { bindings: { Notes: '100/a' }, unresolved: [] });

  // ② 相册消失：本次掉绑、名字保留在行里（`rows` 就是这次落盘的内容）。
  const dropped = resolveTargetBindings(rows, [newcomer], first.bindings, rows);
  assert.deepEqual(dropped, { bindings: {}, unresolved: ['Notes'] }, '相册没了就掉绑，不改投新群同名相册');

  // ③ 下一次**完全相同**的保存：上次落盘的行里已经有 `Notes` 且没绑上 → 不再尝试解析。
  //    （不带 previousRows 时旧实现会把它当新名字绑到 `200/b`——一次相册消失就静默改投。）
  assert.deepEqual(
    resolveTargetBindings(rows, [newcomer], dropped.bindings),
    { bindings: { Notes: '200/b' }, unresolved: [] },
    '不带历史行时确实会改绑（对照组：证明上一行的断言确实在拦它）',
  );
  assert.deepEqual(
    resolveTargetBindings(rows, [newcomer], dropped.bindings, rows),
    { bindings: {}, unresolved: ['Notes'] },
    '带历史行（= 本次落盘的内容）→ 继续未绑定，等用户重选',
  );

  // ④ 用户显式重选（值变了）→ 标记失效，正常解析。
  const repicked = resolveTargetBindings(
    [{ source: '100', targets: ['周报'], entry: true, weekly: false }],
    [newcomer, weekly],
    dropped.bindings,
    rows,
  );
  assert.deepEqual(repicked, { bindings: { 周报: '200/c' }, unresolved: [] });

  // ⑤ 标记按「来源群 + 名字」记：另一个来源群的新选择照常解析。
  const otherSource = resolveTargetBindings(
    [{ source: '200', targets: ['Notes'], entry: true, weekly: false }],
    [newcomer],
    dropped.bindings,
    rows,
  );
  assert.deepEqual(otherSource, { bindings: { Notes: '200/b' }, unresolved: [] });
});

test('ALBUM-19: 5 行 × 13 个未探测目标（第 65 个）全部能通过严格 union 校验', async () => {
  const rows = Array.from({ length: 5 }, (_, rowIndex) => ({
    source: `${1000 + rowIndex}`,
    targets: Array.from({ length: 13 }, (_, index) => `9/v${rowIndex}-${index}`),
    entry: true,
    weekly: false,
  }));
  const configured = rows.flatMap((row) => row.targets);
  assert.equal(configured.length, 65);

  // 静态 const union 的校验是严格的：少一个已保存值，整份插件配置就过不了校验。
  const schema = subscriptionTargetsSchema([], configured);
  for (const row of rows) {
    assert.doesNotThrow(() => schema(row.targets), `第 ${row.source} 行的目标必须全部命中候选`);
  }

  // 每个已保存值都在候选里（面板下拉可见，不会一保存就被清掉）。
  const values = new Set(albumUnionItems([], configured, { targets: true }).map((item) => item.value));
  for (const value of configured) assert.equal(values.has(value), true);

  // 同一份配置走实例 yml 的读取路径：`configuredFromBlocks` 同样不得截断，
  // 否则启动期候选里少了第 65 个，整份插件配置一样过不了校验。
  const dir = path.resolve('tmp/configured-65');
  const yaml = ['plugins:', '  patchouli-knowledge:', '    storage:', '      wikiDir: data/llmwiki', '    subscriptions:'];
  for (const row of rows) {
    yaml.push(`      - source: '${row.source}'`);
    yaml.push(`        targets: [${row.targets.map((target) => `'${target}'`).join(', ')}]`);
  }
  try {
    await makeInstance(dir, yaml, []);
    assert.equal(readStartupTargetValues({ baseDir: dir }).configured.length, 65, '启动期同样收下全部已配置值');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
