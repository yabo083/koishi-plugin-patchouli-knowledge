# 定时投递、限量投递（cron）

> 状态：定稿 v4（cron 按投递类型拆分），已实施。
> v3→v4 变更：① 单一 `cron` 拆成 `entryCron`（日词条）与 `weeklyCron`（周主题）——
> 两类事件节律不同，混在一个输入框里改一个必然改到另一个；② 旧 `settings.json` 里的
> `cron` 读成 `entryCron`、`weeklyCron` 置空（写盘只写新字段）；③ `POST /api/policies`
> 改为**局部更新**（没给的字段沿用该项现值），出现旧字段 `cron` 直接 400；
> ④ 右键菜单拆成「日词条投递时间」「周主题投递时间」两块。
> v2→v3 变更：① 窗口语法换成标准 5 字段 cron；② 策略键从「目标稳定地址」改为
> `<来源群>\u0000<目标键>`（同一个投递群在不同监听群下各有一份策略）；
> ③ 抖动 / 随机间隔不再暴露给用户，内化为投递逻辑常量；④ 配置入口从插件页表格
> 改为订阅表「投递群」标签的右键菜单（`POST /api/policies` 逐项 upsert）。

## 1. 需求

1. **定时投递**：某个（监听群 × 投递目标）只在指定 cron 触发点投递；**日词条与周主题各配一条**
   （`entryCron` / `weeklyCron`）。
2. **限量投递**：该目标每自然日 / 每自然周最多投 N 条。
3. **双重独立**：同一订阅行里的不同目标互不影响；同一个投递群挂在两个监听群下也互不影响；
   两条 cron 也互相独立（改周主题不动词条时间）。
4. **随机间隔**：同一目标相邻两条错开 1–3 分钟（内部常量），降低平台风控特征。
5. **底层批量**：一批到期条目合并成一次 `broadcast`，不逐条调用。
6. 不破坏订阅表四列语义；不配置时行为与现网完全一致（立即投、不限量）。

## 2. 目标标识与字段

```ts
/** settings.json 顶层，与 targetBindings 并列、同一次原子写。 */
export type TargetPolicies = Record<string, TargetPolicy>;   // ≤256 项

export interface TargetPolicy {
  /** 日词条投递时间：5 字段 cron（分 时 日 月 周，Asia/Shanghai）；空串 = 立即投。 */
  entryCron: string;
  /** 周主题（周报）投递时间：5 字段 cron；空串 = 立即投。 */
  weeklyCron: string;
  /** 每自然日上限；0 = 不限。 */
  perDay: number;
  /** 每自然周上限（ISO 周，周一起）；0 = 不限。 */
  perWeek: number;
}
```

排期时按事件类型取对应那条：`cronForKind(policy, kind)` → `entryCron`（`kind: 'entry'`）
或 `weeklyCron`（`kind: 'weekly'`），再交给 `nextCronAt`。

旧数据的单一 `cron` 由 `normalizePolicy` 兼容读：没有 `entryCron` 时把 `cron` 当
`entryCron`、`weeklyCron` 置空；写盘只写两个新字段。四字段全默认 = 没有策略（面板删项）。

键 = `<来源群>\u0000<目标键>`：

- 来源群：去平台前缀的群号（`onebot:` 之类不吃进键里）。
- 目标键：`@chat:<来源群>`（本群聊天）或 `群号/相册ID`（相册稳定地址）。
- 两段都不会含 NUL，分隔符无歧义；旧形状（单段键、`window` / `entryPerDay` 字段）
  在 `parsePolicies` 里静默丢弃——**旧策略不会「意外全开」或「意外全关」**。

`cron` 语法（`policy-resolve.parseCron`）：

| 写法 | 含义 |
| --- | --- |
| `*` | 全区间 |
| `7` / `1-5` | 单值 / 闭区间 |
| 步进（`a/n`、`a-b/n`，通配步进写作 `*` 加 `/n`） | 从起点每隔 n |
| `1,15,30` | 逗号列表（可混用上述三种） |

字段区间：分 0–59、时 0–23、日 1–31、月 1–12、周 0–6（0=周日，**不认 7**）。
非法（字段数不符 / 越界 / 空段 / 步长 0 / 倒序 / 超长）返回 `null`，绝不抛。

## 3. 语义决策

| 问题 | 决策 |
| --- | --- |
| 带 cron 的事件 | **排队**到下一次触发（不丢弃，不让讨论结束时刻决定词条可见性） |
| 两条 cron 各管一类 | `kind: 'entry'` 只读 `entryCron`、`kind: 'weekly'` 只读 `weeklyCron`（`cronForKind`）；某条为空即该类事件立即投 |
| 「下一次」 | `nextCronAt` 取**严格大于**入队时刻的触发点；正好在触发点上时排到下一轮 |
| 时区 | `Asia/Shanghai`，本地年月日时分只从 `Intl.DateTimeFormat` 取，偏移由同一份本地时间反推 |
| 日与周同时设限 | 标准 cron 并集语义（任一命中即触发） |
| 周报与 cron | 周报仍由全局 `albumDelivery.cron` 取材，产物进队列按目标 `weeklyCron` 到点发；`fireKey` 保持取材时刻 |
| 限量口径 | 按**事件 × （来源群 × 目标）**计数：词条 `entryId`、周报 `fireKey`；同一事件投多个目标时每个目标各判一次 |
| 周期 | 词条按自然日（上海 00:00 切），周报按周一起算的自然周；惰性比较 `periodKey` 清零 |
| 占额时机 | **到点、渲染前判定**并占额：cron 把事件推到未来的那一段不占额；超额条目直接出队不渲染；重试中的条目不重复判额 |
| 同目标间隔 | 入队时算进 `dueAt`：同一（来源群 × 目标）相邻两条至少 60–180 秒（1–3 分钟）随机（内部常量） |
| 窗口 | 已删除。需要「只在某时段投」就写 cron（如 `0 22-23 * * *` 每小时的 0 分投） |
| AIMD | 不接额度 |

## 4. 批量投递契约

宿主已有批量入口 `deliverCardToTargets` → `ctx['miyako-delivery'].broadcast(deliveries)`（一次 Write-Ahead、每目标独立退避重试），`DELIVERY-BATCH-01` 锁定「有 broadcast 不得逐个 deliver」。

drain 的单位是**一批**：

```ts
const due = queue.takeDue(now, MAX_ITEMS_PER_BATCH, MAX_BYTES_PER_BATCH); // 20 条 / 8 MiB
const { admitted, overQuota } = queue.filterByQuota(due, now); // 串行链内：判额、占额、超额出队
const rendered = await renderAll(admitted);                    // 只渲染额度内的条目
const deliveries = rendered.flatMap((r) => r.targets.map((t) => ({ target: t, ...r.payload })));
const result = await deliverCardToTargets(ctx, deliveries);   // 一次 broadcast
// 按 outcomes 逐（产物 × 目标）结算：成功出队，失败留队退避，不整批回滚
```

| 约束 | 值 |
| --- | --- |
| 单批条目 | ≤20 条事件 |
| 单批字节 | ≤8 MiB，超限提前切批 |
| 结算粒度 | 逐（产物 × 目标）：一条事件投三目标，两个成功一个失败时只重试失败那个 |
| 渲染失败 | 重试 3 次后出队并 warn，不阻塞同批 |
| 目标失效 | 该目标出队并 warn（沿用绑定表「未绑定即停投」语义） |
| broadcast 缺失 | 整批失败并 warn，不留逐条 fallback |

## 5. 状态文件

`.patchouli/delivery-state.json`（独立文件、独立原子写、`0600`）：

```ts
interface DeliveryState {
  version: 1;
  queue: QueuedDelivery[];        // ≤1024 条，序列化 ≤1 MiB
  counters: Record<string, Counter>;  // 键 = `${kind}\u0000${来源群}\u0000${目标键}` → { periodKey, used }
}
interface QueuedDelivery {
  seq: number;          // 单调递增，FIFO
  source: string;       // 来源群（去平台前缀）
  targetKey: string;    // '@chat:<source>' | '群号/相册ID'
  kind: 'entry' | 'weekly';
  eventKey: string;     // entryId | fireKey
  createdAt: number;
  dueAt: number;        // cron 触发点 + 同目标随机间隔；空 cron = createdAt
  channelId: string;
  attempts: number;
}
```

队列满（1024 条或 1 MiB）时**拒收新事件并 warn**，不淘汰旧项。坏文件按空状态处理并 warn，写路径拒绝覆盖。
旧版状态文件的 `deliverAt` 读回当 `dueAt`（同一语义：绝对值），升级不丢待投队列。

## 6. 配置面呈现

订阅表本身**不改列**（仍是 监听群 / 投递群 / 词条 / 周报）。策略挂在**投递群标签的右键菜单**上：

```
监听群 200 的「周报相册」标签 → 右键：
  日词条投递时间  0 22 * * *   ［立即投］       （留空 = 立即投）
                  每天 22:00 / 每天 09:00        （预设 chips）
  周主题投递时间  0 9 * * 1    ［立即投］
                  每周一 09:00 / 每周五 20:00
  限量            词条/日 3   周报/周 1          （0 = 不限）
```

两块之间与「限量」区同为 12px 分隔线（`.ptx-policy-sec + .ptx-policy-sec`）。

- `GET /api/policies` → `{ policies: [{ source, target, entryCron, weeklyCron, perDay, perWeek }] }`。
  键拆成 `source` + `target`；`target` 优先回显订阅表里的写法（相册名 / `@chat`），
  拿不到名字时回退稳定地址，前端按标签文案匹配后缀（`entryCron·周weeklyCron·限量`）。
- `POST /api/policies` body `{ source, target, entryCron?, weeklyCron?, perDay?, perWeek? }`：
  **逐项 upsert + 局部更新**——没给的字段沿用该项现有值，只改给出来的；四字段全缺省
  （两条 cron 都空 / 0 / 0）= 删除该项。相册名按绑定表解析成 `群号/相册ID`，
  解析不到 400（存一个永远匹配不上的键等于静默不生效）。旧字段 `cron` 直接 400
  （静默忽略会让旧面板缓存把投递时间清成「立即投」）。
- 非法输入（cron 语法 / 额度越界 / 空 source / 空 target）一律 400 且**文件字节不变**。
- 并发保存串行化在同一条读改写链上（`upsertTargetPolicy`），不会互相覆盖。
- `GET /api/settings` 的 `policies` 与 `GET /api/policies` 同形（只读展示）；
  `POST /api/settings` 的 `section: 'policies'` 一律 400——策略只有一个写入口。

## 7. 改动点

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `TargetPolicy` = `{ entryCron, weeklyCron, perDay, perWeek }`；`TargetPolicies` 键为 `<来源群>\u0000<目标键>`；删除 `DeliveryPolicyRow` |
| `src/plugin/policy-resolve.ts` | `parseCron` / `nextCronAt` / `cronForKind` / `policyKey` / `splitPolicyKey` / `isPolicyKey` / `periodKeyFor` / `parsePolicies` / `validatePolicies`；旧 `cron` 按 `entryCron` 别名读；窗口语法整体删除 |
| `src/plugin/delivery-gate.ts` | `offer` 按 `kind` 取 `entryCron` / `weeklyCron` 排定 `dueAt`（再退同目标随机间隔）；`drain` 到点判额度；单定时器指向最早 `dueAt` |
| `src/plugin/delivery-state.ts` | 队列项 `dueAt`（兼容旧 `deliverAt`）；计数键含来源群 |
| `src/plugin/settings-store.ts` | `upsertTargetPolicy`（单条 upsert，同一条串行链） |
| `src/plugin/index.ts` | 删除插件页 `deliveryPolicies` 表格与 `syncDeliveryPolicies`；闸门只读 `settings.json.policies` |
| `src/plugin/weekly-album.ts` | `allowTarget(album, source)` 预筛（最终以 drain 到点判定为准） |
| `src/web/api.ts` | `GET/POST /api/policies`（POST 局部更新、旧 `cron` 400）；`/api/settings` 的 `policies` 改数组形状 |
| `client/dist/index.js` | 订阅表投递群标签的右键菜单（两块投递时间）+ 标签后缀 `entryCron·周weeklyCron·限量` |
| `docs/`、`src/plugin/README.md`、`tests/test-suite.md` | 同步 |

不动：`registerWeeklyCron`、`TopicScheduler`、`applySettingsOverrides`、触发器状态机、`delivery.ts`（批量入口复用现有 `deliverCardToTargets`）。

## 8. 测试矩阵

| 用例 | 断言 |
| --- | --- |
| `CRON-01` 五字段 | 归一形状；通配步进覆盖全区间 = 通配 |
| `CRON-02` 步进与列表 | `*/15`、`9-17`、`a/n`、逗号并列、去重升序 |
| `CRON-03` 非法 | 字段数不符 / 越界 / 步长 0 / 倒序 / 周 7 一律 `null` |
| `CRON-04` 下一次触发 | 严格大于 `at`；正好在触发点上 → 次日 |
| `CRON-05` 时区边界 | UTC 与上海日期分界按本地算；周字段按上海星期 |
| `CRON-06` 跨日/周/月 | 周一 / 每月 1 号 / 闰日；日与周同时设限取并集 |
| `SCHED-01` 无策略 | 直通，队列 `dueAt = createdAt` |
| `SCHED-02` 空 cron | 立即投，不延后 |
| `SCHED-03` cron 到点 | 入队后 `nextWakeAt` = 触发点；提前 drain 空转 |
| `SCHED-04` 当天已过 | 排到次日（严格大于） |
| `SCHED-05` 到点判额 | 同目标第二条超额丢弃，别的目标照常投；同目标第二条退一个随机间隔 |
| `SCHED-06` 每日限量 | `perDay=2`，第 3 条到点丢弃并 warn |
| `SCHED-07` 多目标不倍增 | 同一 `entryId` 投 3 目标各扣各自额度 1 次 |
| `SCHED-08` 周期滚动 | 跨自然日 / 周清零 |
| `SCHED-09` 跨重启 | 队列（含 `dueAt`）与计数持久化；同 `eventKey` 不重复入队 |
| `SCHED-10` 随机间隔 | 1–3 分钟、落库、重启不重算 |
| `SCHED-11` 批量 | 3 个目标同时到期 → 一次 `broadcast` |
| `SCHED-12` 批量部分失败 | 按 outcome 只重试失败目标 |
| `SCHED-13` 队满 | 第 1025 条拒收并 warn，旧项保留 |
| `SCHED-14` 坏状态文件 | 当空状态 + 一次 warn，文件不被覆盖 |
| `SCHED-15` 并发 offer | 同 `eventKey` 并发只入队一次 |
| `SCHED-16` dispose | 定时器停止、不再发送 |
| `SCHED-17` 目标失效 | 该目标出队并 warn，同批其他目标照常投 |
| `SCHED-18` 跨来源独立 | 同一投递群在两个监听群下额度 / 间隔互不影响 |
| `SCHED-19` 超额不渲染 | `perDay=2`、5 条同时到点：渲染桩只跑 2 次、3 条出队并 warn、`overQuota=3`、`deliver` 只收到 2 条 |
| `SCHED-20` 重试不重复占额 | 首次投递失败退避，重试仍算同一额度（`attempts > 0` 跳过判额） |
| `SCHED-21` 并发 drain | 串行链内判额 / 占额只跑一遍，同一额度不会被两轮 drain 各占一次 |
| `SCHED-22` 同一分钟 | 入队时刻与 `weeklyCron` 同一分钟 → 当场到期，不推迟一周 |
| `SCHED-23` 错过本分钟 | 匹配分钟已过（09:01:30）→ 排到下一个周一 09:00，不补发 |
| `SCHED-24` 满额但有下一班 | `perDay=1` 已投 + `entryCron='0 9 * * *'`，10:00 入队：`allows=false` 但 `wouldDeferPastPeriod=true`，该条留在队列、`dueAt` = 次日 09:00，次日新周期照常投 |
| `SCHED-25` 满额且无下一班 | 空 cron（立即投）+ 满额：`wouldDeferPastPeriod=false`，到点出队丢弃（`overQuota=1`） |
| `ENTRY-QUOTA-01` sink 预筛 | `allows=false` 的目标被剔除，不渲染、不入队、不动额度；周期滚动后重新放行 |
| `ENTRY-QUOTA-02` sink 满额留队 | 满额但下一班在明天的目标与有额度的目标都进 `offer`（A 排次日 / B 当场到点）；只有「本周期就到期且满额」的剔除 |
| `POLICY-CRON-SPLIT-01` 两条 cron 分流 | 同一目标 `entryCron='0 22 * * *'` / `weeklyCron='0 9 * * 1'`：词条 `dueAt` = 当天 22:00，周报 = 下周一 09:00，两批各自到点才发 |
| `POLICY-CRON-SPLIT-02` 旧数据迁移 | 只有 `cron` 的旧项读成 `entryCron`、`weeklyCron` 为空；新旧同时出现以 `entryCron` 为准 |
| `POLICY-10..13` | 键形状、归一（含 `cronForKind`）、整表清洗与严格校验、周期键 |
| `POLICY-API-01` | GET 拆键（两条 cron）、POST 局部更新 upsert、四字段缺省删项、旧 `cron` 400、400 不改文件、并发串行 |

## 9. 三个坑

1. **`@chat` 必须带来源群**：同一个 `@chat` 在不同 `source` 行里指向不同群，目标键是 `@chat:<source>`，
   策略键再前置来源群，两层都不能省。
2. **延后的周报不能用唤醒时刻当 `fireKey`**：必须用取材时刻，否则重启后同一周报算成不同事件、重复占额。
3. **本地占额与外发非原子**：保证不超额，不承诺恰好一次；占额后崩溃会少发一条（可接受），反向不可接受。

## 10. 未决

- `*` 行（监听全部群）目前不支持挂策略：来源群不确定，API 直接 400；
  需要的话应展开成全群各自的键（写入口负责），而不是引入通配键。
- 同目标随机间隔当前固定 1–3 分钟，是否要按目标可配。
