import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRichElements } from '../lib/index.js';

test('QQ-VIDEO-CARD: mini-app detail_1 qqdocurl is retained as a navigation link', async () => {
  const result = await parseRichElements({ rawMessage: [{ type: 'json', data: { data: JSON.stringify({
    app: 'com.tencent.miniapp_01',
    view: 'detail_1',
    meta: { detail_1: { title: '哔哩哔哩', desc: '视频标题', qqdocurl: 'https://b23.tv/example', preview: 'https://i0.hdslb.com/cover.jpg' } },
  }) } }] });
  assert.deepEqual(result, [{
    type: 'card', title: '哔哩哔哩', text: '视频标题', url: 'https://b23.tv/example', imageUrl: 'https://i0.hdslb.com/cover.jpg', source: 'com.tencent.miniapp_01',
  }]);
});
