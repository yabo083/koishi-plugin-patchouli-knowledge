import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY,
  MAX_TARGET_POLICIES,
  deliverAtFor,
  nextWindowStart,
  normalizePolicy,
  parsePolicies,
  parseWindow,
  periodKeyFor,
  validatePolicies,
  windowContains,
  windowSpecFor,
} from '../lib/index.js';

/** ISO 时间串（UTC）→ epoch ms：断言里一律写 UTC，避免测试机时区影响结论。 */
const utc = (iso) => Date.parse(iso);

const at = (hour, minute = 0) => hour * 60 + minute;

test('POLICY-01: 窗口语法的四种写法与 `~N` 后缀', () => {
  assert.deepEqual(parseWindow('* 22:00-23:30'), {
    days: [0, 1, 2, 3, 4, 5, 6],
    startMin: at(22),
    endMin: at(23, 30),
    jitterMinutes: 0,
  });
  assert.deepEqual(parseWindow('1 09:00-10:00'), {
    days: [1],
    startMin: at(9),
    endMin: at(10),
    jitterMinutes: 0,
  });
  assert.deepEqual(parseWindow('1 09:00'), {
    days: [1],
    startMin: at(9),
    endMin: at(9) + 1,
    jitterMinutes: 0,
  });
  // 不带前缀 = 每天；结束早于开始 = 跨午夜，`endMin` 越过 1440（相对开始日）。
  assert.deepEqual(parseWindow('22:00-02:00'), {
    days: [0, 1, 2, 3, 4, 5, 6],
    startMin: at(22),
    endMin: at(2) + 1440,
    jitterMinutes: 0,
  });
  // 前后空白与 `~N` 之间的空白都容忍。
  assert.deepEqual(parseWindow('  * 22:00 - 23:30 ~ 15 '), {
    days: [0, 1, 2, 3, 4, 5, 6],
    startMin: at(22),
    endMin: at(23, 30),
    jitterMinutes: 15,
  });
  assert.equal(parseWindow('0 23:59').endMin, 1440, '23:59 的一分钟窗口右边界正好是次日 00:00');
});

test('POLICY-02: 非法窗口一律 null（不抛）', () => {
  const invalid = [
    '',
    '   ',
    'nope',
    '1 09:00-10:00-11:00',
    '8 09:00-10:00', // 星期越界（0=周日 … 6=周六）
    '7 09:00', // 不认 7=周日，避免与 0 两套口径
    '1 24:00-25:00', // 时刻越界
    '1 09:60-10:00',
    '22:00-22:00', // 零长窗口语义不明，拒绝
    '1 09:00-10:00 ~1441', // 抖动超上限
    '1 09:00-10:00 ~-1',
    '1 09:00-10:00 ~1.5',
    '*'.repeat(200),
    `${'1'.repeat(60)}/A1`,
  ];
  for (const text of invalid) {
    assert.equal(parseWindow(text), null, `${JSON.stringify(text)} 必须判为非法`);
  }
});

test('POLICY-03: 窗口命中左闭右开，边界按分钟口径', () => {
  const spec = parseWindow('* 22:00-23:30');
  assert.equal(windowContains(spec, utc('2026-11-24T14:00:00Z')), true, '22:00 整 = 左闭');
  assert.equal(windowContains(spec, utc('2026-11-24T14:30:00Z')), true);
  assert.equal(windowContains(spec, utc('2026-11-24T15:29:59Z')), true, '23:29:59 仍在窗口内');
  assert.equal(windowContains(spec, utc('2026-11-24T15:30:00Z')), false, '23:30 整 = 右开');
  assert.equal(windowContains(spec, utc('2026-11-24T13:59:00Z')), false, '21:59 未开窗');
  assert.equal(windowContains(spec, utc('2026-11-24T16:00:00Z')), false, '次日 00:00 已关窗');
});

test('POLICY-04: 跨午夜窗口的尾巴归开始日', () => {
  const night = parseWindow('22:00-02:00');
  assert.equal(windowContains(night, utc('2026-11-24T17:30:00Z')), true, '次日 01:30 属于前一日开窗');
  assert.equal(windowContains(night, utc('2026-11-24T17:59:59Z')), true);
  assert.equal(windowContains(night, utc('2026-11-24T18:00:00Z')), false, '次日 02:00 整关窗');
  assert.equal(windowContains(night, utc('2026-11-24T16:00:00Z')), true, '次日 00:00 仍属前一日开窗的尾巴');
  assert.equal(windowContains(night, utc('2026-11-24T13:59:00Z')), false, '21:59 当天还没开窗');

  // 周一（2026-11-23）22:00 开窗 → 周二（11-24）01:30 仍属周一夜；周二 22:30 不是周一窗口。
  const mondayNight = parseWindow('1 22:00-02:00');
  assert.equal(windowContains(mondayNight, utc('2026-11-23T17:30:00Z')), true, '周二 01:30 属周一夜');
  assert.equal(windowContains(mondayNight, utc('2026-11-23T14:30:00Z')), true, '周一 22:30 开窗中');
  assert.equal(windowContains(mondayNight, utc('2026-11-24T14:30:00Z')), false, '周二 22:30 不是周一窗口');
});

test('POLICY-05: 指定星期的窗口（时区边界）', () => {
  const monday = parseWindow('1 09:00-10:00');
  assert.equal(windowContains(monday, utc('2026-11-23T01:30:00Z')), true, '周一 09:30 上海');
  assert.equal(windowContains(monday, utc('2026-11-24T01:30:00Z')), false, '周二 09:30 不在周一窗口');
  // UTC 周日 16:30 = 上海周一 00:30：星期必须按上海本地算，不能按 UTC（否则会算成周日）。
  assert.equal(windowContains(parseWindow('1 00:00-01:00'), utc('2026-11-22T16:30:00Z')), true);
  assert.equal(windowContains(parseWindow('0 00:00-01:00'), utc('2026-11-22T16:30:00Z')), false);
});

test('POLICY-06: 下一个窗口首刻', () => {
  const spec = parseWindow('* 22:00-23:30');
  assert.equal(
    nextWindowStart(spec, utc('2026-11-24T12:00:00Z')),
    utc('2026-11-24T14:00:00Z'),
    '20:00 → 当天 22:00',
  );
  assert.equal(
    nextWindowStart(spec, utc('2026-11-24T14:30:00Z')),
    utc('2026-11-25T14:00:00Z'),
    '已在窗口内 → 下一个窗口（次日 22:00）',
  );
  assert.equal(
    nextWindowStart(spec, utc('2026-11-24T14:00:00Z')),
    utc('2026-11-24T14:00:00Z'),
    '正好在首刻 = 首刻本身（`>= at`）',
  );
  const night = parseWindow('22:00-02:00');
  assert.equal(
    nextWindowStart(night, utc('2026-11-24T17:30:00Z')),
    utc('2026-11-25T14:00:00Z'),
    '跨午夜尾巴里 → 当天 22:00 再开',
  );
  const monday = parseWindow('1 09:00');
  assert.equal(
    nextWindowStart(monday, utc('2026-11-24T02:00:00Z')),
    utc('2026-11-30T01:00:00Z'),
    '周二 10:00 → 下周一 09:00',
  );
  // 周窗口跨午夜：周一 23:00 → 00:30 的尾巴仍在窗口内，下一次开窗是下周一。
  const mondayNight = parseWindow('1 23:00-00:30');
  assert.equal(windowContains(mondayNight, utc('2026-11-23T16:15:00Z')), true);
  assert.equal(nextWindowStart(mondayNight, utc('2026-11-23T16:15:00Z')), utc('2026-11-30T15:00:00Z'));
});

test('POLICY-07: 抖动落点不越过窗口右边界', () => {
  const spec = parseWindow('* 22:00-23:30');
  const openAt = utc('2026-11-24T14:10:00Z');

  // 已在窗口内：`at` 之前的时间点不能倒流。
  assert.equal(deliverAtFor(spec, openAt, () => 0), openAt);
  assert.equal(deliverAtFor({ ...spec, jitterMinutes: 15 }, openAt, () => 0), openAt, '抽到早于 at 的点 → 仍是 at');

  // 不在窗口内：首刻 + 抖动，落在 [start, min(end, start+15m)]。
  const outside = utc('2026-11-24T12:00:00Z');
  const spec15 = { ...spec, jitterMinutes: 15 };
  const earliest = deliverAtFor(spec15, outside, () => 0);
  assert.equal(earliest, utc('2026-11-24T14:00:00Z'));
  const latest = deliverAtFor(spec15, outside, () => 0.999999);
  assert.ok(latest > earliest);
  assert.ok(latest <= utc('2026-11-24T14:15:00Z'), '抖动上界 = 首刻 + 15 分钟');

  // 抖动远大于窗口长度：抽到窗口外也必须被夹到右边界之内（23:29:59.999）。
  const spec240 = { ...spec, jitterMinutes: 240 };
  const clamped = deliverAtFor(spec240, outside, () => 0.999999);
  assert.equal(clamped, utc('2026-11-24T15:29:59.999Z'), '抖动不得越过窗口右边界');

  // 已在窗口内 + 抖动：结果仍不越过右边界，且不早于 at。
  const inLate = utc('2026-11-24T15:29:00Z');
  const late = deliverAtFor(spec240, inLate, () => 0.999999);
  assert.ok(late >= inLate && late < utc('2026-11-24T15:30:00Z'));

  // 无窗口 = 立即投递，随机源根本不参与。
  assert.equal(deliverAtFor(null, outside, () => 0.5), outside);
});

test('POLICY-08: 周期键——词条按上海自然日，周报按 ISO 周（周一起）', () => {
  assert.equal(periodKeyFor('entry', utc('2026-11-24T14:30:00Z')), '2026-11-24');
  // 上海 00:30 = UTC 前一日 16:30：日切必须按上海，不是 UTC / 宿主时区。
  assert.equal(periodKeyFor('entry', utc('2026-11-24T16:30:00Z')), '2026-11-25');
  assert.equal(periodKeyFor('entry', utc('2026-11-24T15:59:59Z')), '2026-11-24');

  assert.equal(periodKeyFor('weekly', utc('2026-11-22T04:00:00Z')), '2026-W47', '周日属上一周（周一开周）');
  assert.equal(periodKeyFor('weekly', utc('2026-11-23T04:00:00Z')), '2026-W48', '周一开新周');
  assert.equal(periodKeyFor('weekly', utc('2026-11-29T04:00:00Z')), '2026-W48');
  assert.equal(periodKeyFor('weekly', utc('2026-11-30T04:00:00Z')), '2026-W49');
  // 上海 2026-11-30 00:30（UTC 11-29 16:30）已进入下一周。
  assert.equal(periodKeyFor('weekly', utc('2026-11-29T16:30:00Z')), '2026-W49');
  // ISO 跨年归属：2027-01-01 属 2026-W53（周四决定归属年）。
  assert.equal(periodKeyFor('weekly', utc('2027-01-01T04:00:00Z')), '2026-W53');
  assert.equal(periodKeyFor('weekly', utc('2026-01-01T04:00:00Z')), '2026-W01');
});

test('POLICY-09: 策略归一的单一真源（`~N` 归到字段）与缺省值', () => {
  assert.deepEqual(DEFAULT_POLICY, { window: '', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 });
  assert.deepEqual(normalizePolicy({}), DEFAULT_POLICY, '空对象 = 无限制');
  assert.deepEqual(
    normalizePolicy({ window: '* 22:00-23:30 ~15', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 0 }),
    { window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 15 },
    '文本里的 `~N` 优先并归一到字段，文本不再带后缀',
  );
  assert.deepEqual(
    normalizePolicy({ window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 5 }),
    { window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 5 },
  );

  for (const bad of [null, [], 'x', 1, { window: 'nope' }, { entryPerDay: -1 }, { entryPerDay: 1.5 }, { entryPerDay: 1000 }, { weeklyPerWeek: '1' }, { jitterMinutes: 1441 }]) {
    assert.equal(normalizePolicy(bad), null, `${JSON.stringify(bad)} 必须判为非法`);
  }

  assert.deepEqual(windowSpecFor({ ...DEFAULT_POLICY, window: '' }), null, '空窗口 = 立即投递');
  assert.deepEqual(windowSpecFor({ ...DEFAULT_POLICY, window: '* 22:00-23:00', jitterMinutes: 10 }), {
    days: [0, 1, 2, 3, 4, 5, 6],
    startMin: at(22),
    endMin: at(23),
    jitterMinutes: 10,
  });
});

test('POLICY-10: 策略表清洗（读路径）与严格校验（面板 POST）', () => {
  const ok = { '@chat:100': { window: '* 22:00-23:30', entryPerDay: 3, weeklyPerWeek: 1, jitterMinutes: 15 } };
  const bad = {
    '@chat:*': { window: '', entryPerDay: 1, weeklyPerWeek: 0, jitterMinutes: 0 },
    'not-a-target': { window: '', entryPerDay: 1, weeklyPerWeek: 0, jitterMinutes: 0 },
    '100/A1': { window: '25:00-26:00', entryPerDay: 1, weeklyPerWeek: 0, jitterMinutes: 0 },
    '100/A2': null,
  };

  // 读路径：坏项静默丢弃（一份脏文件不得让策略意外全开或整份失效）。
  assert.deepEqual(parsePolicies({ ...bad, ...ok }), ok);
  assert.deepEqual(parsePolicies(null), {});
  assert.deepEqual(parsePolicies([]), {});

  // 条数上限：超出按文件顺序截断。
  const many = {};
  for (let index = 0; index < MAX_TARGET_POLICIES + 10; index += 1) {
    many[`100/A${index}`] = { window: '', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 };
  }
  assert.equal(Object.keys(parsePolicies(many)).length, MAX_TARGET_POLICIES);

  // 写路径：任何一项非法都整单 400，不做「猜一个合法值」的静默替换。
  assert.deepEqual(validatePolicies(ok), { ok: true, value: ok });
  for (const patch of [null, [], 'x', { '@chat:*': ok['@chat:100'] }, { 'not-a-target': ok['@chat:100'] }, { '100/A1': { window: 'nope' } }, { '100/A1': { ...ok['@chat:100'], surprise: 1 } }, { ...bad, ...ok }]) {
    const result = validatePolicies(patch);
    assert.equal(result.ok, false, `${JSON.stringify(patch)} 必须被拒绝`);
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  }
  const tooMany = validatePolicies(many);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, new RegExp(String(MAX_TARGET_POLICIES), 'u'));

  // 缺省字段按 0 补齐（整张表由面板给出，缺字段 = 无限制）。
  assert.deepEqual(validatePolicies({ '100/A1': {} }), {
    ok: true,
    value: { '100/A1': { window: '', entryPerDay: 0, weeklyPerWeek: 0, jitterMinutes: 0 } },
  });
});
