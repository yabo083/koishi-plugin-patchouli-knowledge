import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY,
  MAX_PERIOD_QUOTA,
  MAX_TARGET_POLICIES,
  cronForKind,
  isDefaultPolicy,
  isPolicyKey,
  nextCronAt,
  normalizePolicy,
  parseCron,
  parsePolicies,
  periodKeyFor,
  policyKey,
  splitPolicyKey,
  validatePolicies,
} from '../lib/index.js';

/** 上海时刻 → epoch ms（显式偏移，避免依赖测试机时区）。 */
const sh = (text) => Date.parse(`${text}+08:00`);

test('CRON-01: 五字段解析——字段区间与通配的归一形状', () => {
  assert.deepEqual(parseCron('0 22 * * *'), {
    minutes: [0],
    hours: [22],
    daysOfMonth: null,
    months: null,
    daysOfWeek: null,
  });
  // 前后多余空白容忍：yml / 面板输入都可能带。
  assert.deepEqual(parseCron('  0   22  *  *  *  '), parseCron('0 22 * * *'));
  // 通配步进覆盖整个区间 = 通配（日 / 周据此判断「是否设限」）。
  const every = parseCron('*/1 */1 */1 */1 */1');
  assert.equal(every.minutes.length, 60);
  assert.equal(every.hours.length, 24);
  assert.equal(every.daysOfMonth, null);
  assert.equal(every.months, null);
  assert.equal(every.daysOfWeek, null);
});

test('CRON-02: 步进与逗号列表', () => {
  const spec = parseCron('*/15 9-17 * * 1-5');
  assert.deepEqual(spec.minutes, [0, 15, 30, 45]);
  assert.deepEqual(spec.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(spec.daysOfWeek, [1, 2, 3, 4, 5]);

  const list = parseCron('5,10,25 0,12 1,15 * *');
  assert.deepEqual(list.minutes, [5, 10, 25]);
  assert.deepEqual(list.hours, [0, 12]);
  assert.deepEqual(list.daysOfMonth, [1, 15]);

  // `a/n` = 从 a 起到字段上界每 n 个（标准 cron 简写）。
  assert.deepEqual(parseCron('50/2 * * * *').minutes, [50, 52, 54, 56, 58]);
  // 重复值与乱序要归一成升序去重，否则 nextCronAt 的遍历顺序会错。
  assert.deepEqual(parseCron('30,0,30 12,6 * * *').minutes, [0, 30]);
  assert.deepEqual(parseCron('30,0,30 12,6 * * *').hours, [6, 12]);
});

test('CRON-03: 非法 cron 一律 null（不抛）', () => {
  const invalid = [
    '',
    '   ',
    '0 22 * *', // 4 字段
    '0 22 * * * *', // 6 字段
    '0 22 *', // 3 字段
    '60 22 * * *', // 分越界
    '0 24 * * *', // 时越界
    '0 22 0 * *', // 日从 1 开始
    '0 22 32 * *',
    '0 22 * 13 *',
    '0 22 * * 7', // 不认 7=周日，避免与 0 两套口径
    '*/0 * * * *', // 步长 0
    '5-1 * * * *', // 倒序区间
    'a * * * *',
    '1,,2 * * * *',
    '1- * * * *',
    '*'.repeat(200),
    // 日历上永不发生：语法合法但没有任何日期能命中（2 月没有 30 / 31 号）。
    '0 0 31 2 *',
    '0 0 30 2 *',
    '0 22 31 4,6,9,11 *',
  ];
  for (const text of invalid) {
    assert.equal(parseCron(text), null, `${JSON.stringify(text)} 必须判为非法`);
  }
});

test('CRON-04: nextCronAt 严格大于 at', () => {
  const spec = parseCron('30 22 * * *');
  assert.equal(nextCronAt(spec, sh('2026-11-24T21:00:00')), sh('2026-11-24T22:30:00'), '当天稍后触发');
  assert.equal(nextCronAt(spec, sh('2026-11-24T22:30:00')), sh('2026-11-25T22:30:00'), '正好在触发点 → 次日');
  assert.equal(nextCronAt(spec, sh('2026-11-24T22:30:01')), sh('2026-11-25T22:30:00'));
  assert.equal(nextCronAt(null, sh('2026-11-24T21:00:00')), sh('2026-11-24T21:00:00'), '非法 spec = 立即投');
});

test('CRON-05: 时区边界按上海本地日期算', () => {
  const midnight = parseCron('0 0 * * *');
  // UTC 2026-11-24 15:59:59 = 上海 23:59:59 → 下一次是本地次日 00:00（UTC 16:00）。
  assert.equal(nextCronAt(midnight, Date.parse('2026-11-24T15:59:59Z')), Date.parse('2026-11-24T16:00:00Z'));
  // UTC 16:30 = 上海 11-25 00:30 → 下一次是 11-26 00:00 本地（UTC 11-25 16:00）。
  assert.equal(nextCronAt(midnight, Date.parse('2026-11-24T16:30:00Z')), Date.parse('2026-11-25T16:00:00Z'));
  // 周字段按上海星期：UTC 周日 16:30 = 上海周一 00:30。
  const monday9 = parseCron('0 9 * * 1');
  assert.equal(
    nextCronAt(monday9, Date.parse('2026-11-22T16:30:00Z')),
    sh('2026-11-23T09:00:00'),
    '上海周一 00:30 → 当天 09:00',
  );
});

test('CRON-06: 跨日 / 跨周 / 跨月，以及日与周同时设限取并集', () => {
  const monday = parseCron('0 9 * * 1');
  // 2026-11-24 是周二：下一次周一是 11-30。
  assert.equal(nextCronAt(monday, sh('2026-11-24T10:00:00')), sh('2026-11-30T09:00:00'));

  const monthly = parseCron('0 9 1 * *');
  assert.equal(nextCronAt(monthly, sh('2026-11-24T10:00:00')), sh('2026-12-01T09:00:00'));

  const leapDay = parseCron('0 0 29 2 *');
  assert.equal(nextCronAt(leapDay, sh('2026-11-24T10:00:00')), sh('2028-02-29T00:00:00'), '闰日跨年');

  // `0 12 1 * 1`：每月 1 号 **或** 每周一 12:00（标准 cron 的并集语义）。
  // 2026-11-24 周二 13:00 → 11-30（周一）早于 12-01（1 号）。
  const union = parseCron('0 12 1 * 1');
  assert.equal(nextCronAt(union, sh('2026-11-24T13:00:00')), sh('2026-11-30T12:00:00'));
  assert.equal(nextCronAt(union, sh('2026-12-01T13:00:00')), sh('2026-12-07T12:00:00'), '1 号当天的 12:00 已过');
});

test('CRON-07: 可达性——闰日合法、日周并集合法；搜满上界不折算成立即投', () => {
  // 闰日只是稀有，不是不可能（nextCronAt 会排到下一个闰年）。
  const leapDay = parseCron('0 0 29 2 *');
  assert.ok(leapDay, '2 月 29 日必须合法');
  // 任一所列月份存在该日即可（1 月有 31 号）。
  assert.ok(parseCron('0 0 31 1,2 *'), '1 月 31 日存在 → 合法');
  assert.ok(parseCron('0 0 31 2,3 *'), '3 月 31 日存在 → 合法');
  // 日与周同时设限取并集：2 月的每周一都可能命中，日字段再离谱也有日期。
  assert.ok(parseCron('0 0 31 2 1'), '并集语义下周字段兜住了可达性');

  // 手工构造「永不命中」的 spec（绕过 parseCron 的拒收）：搜满上界后必须排在界外，
  // 绝不能返回 at —— 那会把一次永不到点变成一次立刻外发。
  const impossible = {
    minutes: [0],
    hours: [0],
    daysOfMonth: [31],
    months: [2],
    daysOfWeek: null,
  };
  const at = sh('2026-11-24T10:00:00');
  const fallback = nextCronAt(impossible, at);
  assert.equal(fallback, at + 8 * 366 * 86_400_000, '兜底 = 搜索上界之后');
  assert.ok(fallback > at, '兜底必须严格大于 at');
});

test('POLICY-10: 策略键形状（<来源群> NUL <目标键>）', () => {
  const key = policyKey('200', '@chat:200');
  assert.equal(key, '200\u0000@chat:200');
  assert.deepEqual(splitPolicyKey(key), { source: '200', target: '@chat:200' });
  assert.equal(isPolicyKey(key), true);
  assert.equal(isPolicyKey('200\u0000100/A1'), true, '相册稳定地址');
  assert.equal(isPolicyKey(`${'1'.repeat(65)}\u0000100/A1`), false, '来源群超长');

  for (const bad of [
    '',
    '100/A1', // 旧形状：没有来源群段
    '\u0000100/A1', // 来源群为空
    '200\u0000', // 目标为空
    '200\u0000*', // 目标通配
    '200\u0000100', // 目标既不是 @chat 也不是 群号/相册ID
    '*\u0000100/A1', // 通配来源群
    '20 0\u0000100/A1', // 来源群含空格
    '200\u0000100/A1\u0000x', // 三段
  ]) {
    assert.equal(isPolicyKey(bad), false, `${JSON.stringify(bad)} 必须判为非法键`);
  }
});

test('POLICY-11: 策略归一（缺省 = 两类事件都立即投 / 不限量）', () => {
  assert.deepEqual(DEFAULT_POLICY, { entryCron: '', weeklyCron: '', perDay: 0, perWeek: 0 });
  assert.deepEqual(normalizePolicy({}), DEFAULT_POLICY);
  assert.deepEqual(normalizePolicy({ entryCron: ' 0 22 * * * ', weeklyCron: ' 0 9 * * 1 ', perDay: 3, perWeek: 1 }), {
    entryCron: '0 22 * * *',
    weeklyCron: '0 9 * * 1',
    perDay: 3,
    perWeek: 1,
  });
  assert.equal(isDefaultPolicy(DEFAULT_POLICY), true);
  assert.equal(isDefaultPolicy({ entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 }), false);
  assert.equal(isDefaultPolicy({ entryCron: '0 22 * * *', weeklyCron: '', perDay: 0, perWeek: 0 }), false);
  assert.equal(isDefaultPolicy({ entryCron: '', weeklyCron: '0 9 * * 1', perDay: 0, perWeek: 0 }), false);

  // 两类事件各读各的定时：词条只认 entryCron，周报只认 weeklyCron。
  const split = normalizePolicy({ entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1' });
  assert.equal(cronForKind(split, 'entry'), '0 22 * * *');
  assert.equal(cronForKind(split, 'weekly'), '0 9 * * 1');
  assert.equal(cronForKind(DEFAULT_POLICY, 'entry'), '');
  assert.equal(cronForKind(DEFAULT_POLICY, 'weekly'), '');

  for (const bad of [
    null,
    [],
    'x',
    1,
    { entryCron: 'not-a-cron' },
    { weeklyCron: 'not-a-cron' },
    { entryCron: 5 },
    { cron: 'not-a-cron' },
    { cron: 5 },
    { perDay: -1 },
    { perDay: 1.5 },
    { perDay: MAX_PERIOD_QUOTA + 1 },
    { perWeek: '1' },
    // 日历上永不发生（`0 0 31 2 *`）：保存时 400、读盘时丢弃，绝不排成一个「立即投」。
    { entryCron: '0 0 31 2 *' },
    { weeklyCron: '0 0 31 2 *' },
  ]) {
    assert.equal(normalizePolicy(bad), null, `${JSON.stringify(bad)} 必须判为非法`);
  }
});

test('POLICY-CRON-SPLIT-02: 旧数据只有一个 cron → 读成 entryCron，weeklyCron 为空', () => {
  const key = '200\u0000100/A1';
  const legacy = { [key]: { cron: ' 0 22 * * * ', perDay: 3, perWeek: 1 } };

  // 读路径（settings.json 里的旧形状）：旧键按 entryCron 读，周主题回落「立即投」。
  assert.deepEqual(parsePolicies(legacy), {
    [key]: { entryCron: '0 22 * * *', weeklyCron: '', perDay: 3, perWeek: 1 },
  });
  assert.deepEqual(normalizePolicy({ cron: '0 22 * * *' }), {
    entryCron: '0 22 * * *',
    weeklyCron: '',
    perDay: 0,
    perWeek: 0,
  });
  assert.equal(isDefaultPolicy(normalizePolicy({ cron: '' })), true, '旧空 cron 仍是缺省');

  // 新旧同时出现时以新键为准（旧键只是兼容读法，不得覆盖显式给出的 entryCron）。
  assert.deepEqual(normalizePolicy({ cron: '0 9 * * 1', entryCron: '0 22 * * *' }), {
    entryCron: '0 22 * * *',
    weeklyCron: '',
    perDay: 0,
    perWeek: 0,
  });
});

test('POLICY-12: 策略表清洗（读路径）与严格校验（写路径）', () => {
  const album = '100/A1';
  const ok = {
    [`200\u0000${album}`]: { entryCron: '0 22 * * *', weeklyCron: '0 9 * * 1', perDay: 3, perWeek: 1 },
  };
  const bad = {
    '*\u0000100/A2': { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 },
    '100/A3': { entryCron: '', weeklyCron: '', perDay: 1, perWeek: 0 },
    [`200\u0000100/A4`]: { entryCron: '25:00-26:00', weeklyCron: '', perDay: 1, perWeek: 0 },
    [`200\u0000100/A5`]: { entryCron: '', weeklyCron: '0 9 * * 9', perDay: 1, perWeek: 0 },
    [`200\u0000100/A6`]: null,
    [`200\u0000100/A7`]: { entryCron: '0 0 31 2 *', weeklyCron: '', perDay: 1, perWeek: 0 },
  };

  // 读路径：坏项静默丢弃（一份脏文件不得让策略意外全开或整份失效）。
  assert.deepEqual(parsePolicies({ ...bad, ...ok }), ok);
  assert.deepEqual(parsePolicies(null), {});
  assert.deepEqual(parsePolicies([]), {});

  // 条数上限：超出按文件顺序截断。
  const many = {};
  for (let index = 0; index < MAX_TARGET_POLICIES + 10; index += 1) {
    many[`200\u0000100/A${index}`] = { entryCron: '', weeklyCron: '', perDay: 0, perWeek: 0 };
  }
  assert.equal(Object.keys(parsePolicies(many)).length, MAX_TARGET_POLICIES);

  // 写路径：任何一项非法都整单 400，不做「猜一个合法值」的静默替换。
  assert.deepEqual(validatePolicies(ok), { ok: true, value: ok });
  for (const patch of [
    null,
    [],
    'x',
    { '*\u0000100/A2': ok[`200\u0000${album}`] },
    { '100/A3': ok[`200\u0000${album}`] },
    { [`200\u0000100/A4`]: { entryCron: 'nope' } },
    { [`200\u0000100/A4`]: { weeklyCron: 'nope' } },
    { [`200\u0000100/A4`]: { cron: 'nope' } },
    { [`200\u0000100/A4`]: { ...ok[`200\u0000${album}`], surprise: 1 } },
    { ...bad, ...ok },
  ]) {
    const result = validatePolicies(patch);
    assert.equal(result.ok, false, `${JSON.stringify(patch)} 必须被拒绝`);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  }
  const tooMany = validatePolicies(many);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, new RegExp(String(MAX_TARGET_POLICIES), 'u'));

  // 缺省字段按 0 / 空串补齐（整张表由面板给出，缺字段 = 立即投 + 无限制）。
  assert.deepEqual(validatePolicies({ [`200\u0000100/A1`]: {} }), {
    ok: true,
    value: { [`200\u0000100/A1`]: { entryCron: '', weeklyCron: '', perDay: 0, perWeek: 0 } },
  });
});

test('POLICY-13: 周期键——词条按上海自然日，周报按 ISO 周（周一起）', () => {
  const utc = (iso) => Date.parse(iso);
  assert.equal(periodKeyFor('entry', utc('2026-11-24T14:30:00Z')), '2026-11-24');
  // 上海 00:30 = UTC 前一日 16:30：日切必须按上海，不是 UTC / 宿主时区。
  assert.equal(periodKeyFor('entry', utc('2026-11-24T16:30:00Z')), '2026-11-25');
  assert.equal(periodKeyFor('entry', utc('2026-11-24T15:59:59Z')), '2026-11-24');

  assert.equal(periodKeyFor('weekly', utc('2026-11-22T04:00:00Z')), '2026-W47', '周日属上一周（周一开周）');
  assert.equal(periodKeyFor('weekly', utc('2026-11-23T04:00:00Z')), '2026-W48', '周一开新周');
  assert.equal(periodKeyFor('weekly', utc('2026-11-29T16:30:00Z')), '2026-W49', '上海周一 00:30 已进入下一周');
  // ISO 跨年归属：2027-01-01 属 2026-W53（周四决定归属年）。
  assert.equal(periodKeyFor('weekly', utc('2027-01-01T04:00:00Z')), '2026-W53');
  assert.equal(periodKeyFor('weekly', utc('2026-01-01T04:00:00Z')), '2026-W01');
});
