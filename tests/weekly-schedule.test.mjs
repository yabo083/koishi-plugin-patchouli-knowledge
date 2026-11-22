import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_WEEKLY_CRON, registerWeeklyCron, WEEKLY_TIME_ZONE } from '../lib/index.js';

function recorder() {
  const logs = [];
  return {
    logs,
    logger: { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) },
  };
}

test('WEEKLY-01: 配置为空时回落到默认表达式，并按 Asia/Shanghai 注册', () => {
  const { logger } = recorder();
  const registered = [];
  const stop = () => undefined;
  const disposer = registerWeeklyCron({
    scheduler: {
      scheduleCron(expression, run, options) {
        registered.push({ expression, options, run });
        return stop;
      },
    },
    expression: '   ',
    run: () => undefined,
    logger,
  });
  assert.equal(disposer, stop);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].expression, DEFAULT_WEEKLY_CRON);
  assert.equal(registered[0].options.timeZone, WEEKLY_TIME_ZONE);
});

test('WEEKLY-02: 使用配置提供的表达式（多空格收敛），改表达式即改排程', () => {
  const { logger } = recorder();
  const registered = [];
  registerWeeklyCron({
    scheduler: { scheduleCron: (expression, _run, options) => { registered.push({ expression, options }); return () => undefined; } },
    expression: '  0   9 * * 5 ',
    run: () => undefined,
    logger,
  });
  assert.equal(registered[0].expression, '0 9 * * 5');
});

test('WEEKLY-03: 段数不足的表达式不注册且留下可读告警', () => {
  const { logs, logger } = recorder();
  const disposer = registerWeeklyCron({
    scheduler: { scheduleCron: () => () => undefined },
    expression: '30 4 * *',
    run: () => undefined,
    logger,
  });
  assert.equal(disposer, undefined);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'warn');
  assert.match(logs[0][1], /需要五段/u);
});

test('WEEKLY-04: 宿主解析抛错时不注册，错误文本进告警', () => {
  const { logs, logger } = recorder();
  const disposer = registerWeeklyCron({
    scheduler: {
      scheduleCron() {
        throw new Error('invalid field "99" in minute');
      },
    },
    expression: '99 4 * * 1',
    run: () => undefined,
    logger,
  });
  assert.equal(disposer, undefined);
  assert.match(logs.at(-1)[1], /invalid field/u);
});

test('WEEKLY-05: 宿主不提供 scheduleCron 时明确告警且不注册', () => {
  const { logs, logger } = recorder();
  assert.equal(registerWeeklyCron({ scheduler: undefined, expression: '30 4 * * 1', run: () => undefined, logger }), undefined);
  assert.match(logs[0][1], /未提供 scheduleCron/u);
});
