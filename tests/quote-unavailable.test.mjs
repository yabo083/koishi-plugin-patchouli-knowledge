import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRichElements } from '../lib/index.js';

test('QUOTE-UNAVAILABLE: 引用原消息 1200 时不告警，只给可见占位并保留发送者', async () => {
  const warnings = [];
  const elements = await parseRichElements(
    {
      onebot: {
        get_msg: async () => {
          throw new Error('Error with request get_msg, args: {"message_id":"100000013"}, retcode: 1200');
        },
      },
      quote: { id: '100000013', user: { name: '小蓝' } },
      content: '',
    },
    { warn: (message) => warnings.push(message) },
  );

  assert.equal(elements.length, 1);
  assert.equal(elements[0].type, 'quote');
  assert.equal(elements[0].text, '[引用消息不可用]');
  assert.equal(elements[0].title, '小蓝', '发送者名字必须保留');
  assert.equal(elements[0].targetMessageId, '100000013');
  assert.deepEqual(warnings, [], '常态的不可读引用不得写 warning');
});

test('QUOTE-FAILURE: 真正的通道故障仍然告警并标记解析失败', async () => {
  const warnings = [];
  const elements = await parseRichElements(
    {
      onebot: {
        get_msg: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
      quote: { id: '9001' },
      content: '',
    },
    { warn: (message) => warnings.push(message) },
  );

  assert.equal(elements[0].type, 'quote');
  assert.equal(elements[0].text, '[引用]（解析失败）');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /引用/u);
});

test('FORWARD-UNAVAILABLE: 合并转发 1200 时不告警，只给可见占位', async () => {
  const warnings = [];
  const elements = await parseRichElements(
    {
      onebot: {
        get_forward_msg: async () => {
          throw new Error('Error with request get_forward_msg, args: {"id":"7701201028112829382"}, retcode: 1200');
        },
      },
      rawMessage: [
        { type: 'forward', data: { id: '7701201028112829382' } },
      ],
      content: '',
    },
    { warn: (message) => warnings.push(message) },
  );

  assert.equal(elements.length, 1);
  assert.equal(elements[0].type, 'forward');
  assert.equal(elements[0].text, '[合并转发不可用]');
  assert.deepEqual(warnings, [], '常态的不可读合并转发不得写 warning');
});

test('FORWARD-FAILURE: 真正的合并转发通道故障仍然告警并标记解析失败', async () => {
  const warnings = [];
  const elements = await parseRichElements(
    {
      onebot: {
        get_forward_msg: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
      rawMessage: [
        { type: 'forward', data: { id: '7701201028112829382' } },
      ],
      content: '',
    },
    { warn: (message) => warnings.push(message) },
  );

  assert.equal(elements[0].type, 'forward');
  assert.equal(elements[0].text, '[合并转发]（展开失败）');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /合并转发/u);
});
