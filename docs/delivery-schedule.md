# 定时投递、限量投递与随机抖动

> 状态：设计定稿（v2），待实施。
> 依据：`astra`（gpt-6.2-astra）评审稿；`gemini-3.8-flash-high` 第二意见待回。
> v1→v2 变更：策略单位从「订阅行」改为「**投递目标**」——一行可投多个目标，每个目标各自独立配置。

## 1. 需求

1. **定时投递**：某个投递目标只在指定时间窗口投递。
2. **限量投递**：某个投递目标每周期最多投 N 条。
3. **每目标独立**：同一订阅行里的不同目标互不影响（目标 A 每天 22:00 限 3 条，目标 B 全天不限）。
4. **随机抖动**：投递时刻不规律，降低平台风控特征。
5. **底层批量**：一批到期条目合并成一次 `broadcast`，不逐条调用。
6. 不破坏现有订阅表四列语义；不配置时行为与现网完全一致。

## 2. 目标标识与字段

投递目标在运行期已经有两套标识：

- `@chat` —— 来源群聊天（同一行里 `@chat` 唯一指向 `source`）
- `群号/相册ID` —— 相册稳定地址（由 `targetBindings` 从可读名解析得到）

策略挂在**稳定地址**上，不挂可读名（改相册名不该重置策略）。

```ts
/** settings.json 顶层，与 targetBindings 并列、同一次原子写。 */
export type TargetPolicies = Record<string, TargetPolicy>;   // ≤256 项

export interface TargetPolicy {
  /** 投递窗口；空串 = 全天不限时。 */
  window: string;
  /** 词条每自然日上限；0 = 不限。 */
  entryPerDay: number;
  /** 周报每自然周上限；0 = 不限。 */
  weeklyPerWeek: number;
  /** 窗口内随机抖动上界（分钟）；0 = 不抖动。 */
  jitterMinutes: number;
}
```

键的取值为：
- `@chat:<source>`（`@chat` 需要带来源群才能唯一，见坑 1）
- `群号/相册ID`

`window` 语法：

| 写法 | 含义 |
| --- | --- |
| `* HH:MM-HH:MM` | 每天该区间，左闭右开 |
| `W HH:MM-HH:MM` | 周 W（0=周日，1=周一）该区间 |
| `W HH:MM` | 该日一分钟窗口 |
| `22:00-02:00` | 跨午夜，归开始日 |

## 3. 语义决策

| 问题 | 决策 |
| --- | --- |
| 窗口外发生什么 | **排队**，到下一个窗口投递（不丢弃，不让讨论结束时刻决定词条可见性） |
| 时区 | `Asia/Shanghai`，用 `Intl.DateTimeFormat` 取本地时分 |
| 窗口边界 | 左闭右开；跨午夜归开始日 |
| 周报与窗口 | 周报仍由全局 cron 取材，产物进队列，到窗才发；`fireKey` 保持取材时刻 |
| 限量口径 | 按**事件键**计数：词条 `entryId`、周报 `fireKey`；同一事件投多个目标时，**每个目标各扣一次**（目标是独立额度） |
| 周期 | 词条按自然日（上海 00:00 切），周报按周一起算的自然周；惰性比较 `periodKey` 清零 |
| 占额时机 | 渲染前按（目标 × 事件键）原子占额；批量失败不退还 |
| 抖动 | 入队时算定 `deliverAt` 并落库；不越过窗口右边界；同目标相邻两条至少随机间隔 1–3 分钟 |
| AIMD | 不接额度 |

## 4. 批量投递契约

宿主已有批量入口 `deliverCardToTargets` → `ctx['miyako-delivery'].broadcast(deliveries)`（一次 Write-Ahead、每目标独立退避重试），`DELIVERY-BATCH-01` 锁定「有 broadcast 不得逐个 deliver」。

drain 的单位是**一批**：

```ts
const due = queue.takeDue(now, MAX_ITEMS_PER_BATCH, MAX_BYTES_PER_BATCH); // 20 条 / 8 MiB
const rendered = await renderAll(due);                       // 每条一张图
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
  counters: Record<string, Counter>;  // 键 = `${targetKey}\u0000${periodKey}` → used
}
interface QueuedDelivery {
  seq: number;          // 单调递增，FIFO
  source: string;       // 来源群
  targetKey: string;    // '@chat:<source>' | '群号/相册ID'
  kind: 'entry' | 'weekly';
  eventKey: string;     // entryId | fireKey
  createdAt: number;
  deliverAt: number;    // 已含抖动
  channelId: string;
}
```

队列满（1024 条或 1 MiB）时**拒收新事件并 warn**，不淘汰旧项。坏文件按空状态处理并 warn，写路径拒绝覆盖（沿用 `SettingsDocumentError`）。

## 6. 面板呈现

订阅表本身**不改列**（仍是 监听群 / 投递群 / 词条 / 周报）。策略放在新增的「投递策略」区块（同一面板，`/patchouli/api/settings` 的 `policies` 段）：

```
目标                     窗口              词条/日  周报/周  抖动
群聊 / 知识库            * 22:00-23:30     3        1        ±15m
群聊（本群聊天）          * 09:00-10:00     0        0        ±5m
```

- 列表从当前 `targetBindings` + `@chat:<source>` 生成，只显示实际存在的目标。
- 未配置目标 = 全天不限时、不限量、无抖动。
- 保存走 `POST /api/settings` 的 `policies` 段，与 `targetBindings` 同一次原子写。

理由：策略的宿主是「投递目标」而非「订阅行」，表格单元格无法表达多目标多策略；放区块后表格保持紧凑，且删相册绑定即自动失效（不存在悬空）。

## 7. 改动点

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `TargetPolicy` / `TargetPolicies` |
| `src/plugin/settings-store.ts` | `parseDocument` 增加 `policies` 段清洗（≤256 项、窗口语法校验、数值边界）；`writeTargetPolicies` 与 `writeTargetBindings` 同批落盘 |
| `src/plugin/policy-resolve.ts`（新） | `parseWindow(text)`、`policyFor(targetKey)`、`periodKey(kind, at)`、`jitterFor(policy, windowStart, at)` |
| `src/plugin/delivery-gate.ts`（新） | `offer(event)`、`drain(now)`、`nextWakeAt(now)`、`dispose()`；单定时器 |
| `src/plugin/delivery-state.ts`（新） | 队列/计数读写、上限、原子写、串行队列 |
| `src/plugin/index.ts` | `handleQuiescence` 结算后改 `gate.offer(...)`；`runWeeklyAlbumUpload` 产物同样 `offer`；`dispose` 里停闸 |
| `src/plugin/weekly-album.ts` | `planWeeklyAlbumSources` 预筛（最终以占额为准） |
| `src/web/api.ts` | `settings` 段增加 `policies` 读写；`GET` 返回目标清单供面板渲染 |
| `docs/`、`src/plugin/README.md`、`tests/test-suite.md` | 同步 |

不动：`registerWeeklyCron`、`TopicScheduler`、`applySettingsOverrides`、触发器状态机、`delivery.ts`（批量入口复用现有 `deliverCardToTargets`）。

## 8. 测试矩阵

| 用例 | 断言 |
| --- | --- |
| `SCHED-01` 无策略 | 行为与现网一致，直通不受影响 |
| `SCHED-02` 窗口内 | 立即投递，队列不增长 |
| `SCHED-03` 窗口外排队 | 入队不投；到窗口首刻投出 |
| `SCHED-04` 跨午夜 | `22:00-02:00` 的 01:30 属开始日窗口 |
| `SCHED-05` 每目标独立 | 同一事件投 A/B 两目标，A 满额丢弃、B 照常投 |
| `SCHED-06` 限量 | `entryPerDay=2`，第 3 条丢弃并 warn |
| `SCHED-07` 多目标不倍增 | 同一 `entryId` 投 3 目标各扣各自额度 1 次 |
| `SCHED-08` 周期滚动 | 跨自然日/周清零 |
| `SCHED-09` 跨重启 | 队列与计数持久化；同 `eventKey` 不重复扣 |
| `SCHED-10` 抖动 | `jitterMinutes=15` → `deliverAt ∈ [windowStart, min(windowEnd, start+15m)]`，重启不重算 |
| `SCHED-11` 批量 | 3 条同时到期 → 一次 `broadcast`，`deliveries.length = 3 × 目标数` |
| `SCHED-12` 批量部分失败 | 按 outcome 只重试失败目标，成功项不重复投 |
| `SCHED-13` 队满 | 第 1025 条拒收并 warn，旧项保留 |
| `SCHED-14` 坏状态文件 | 当空状态 + 一次 warn，文件不被覆盖 |
| `SCHED-15` 并发 offer | 同 `eventKey` 并发只入队一次 |
| `SCHED-16` dispose | 定时器停止、不再发送 |
| `SCHED-17` 目标失效 | 该目标出队并 warn，同批其他目标照常 |

## 9. 三个坑（astra 提出，已确认）

1. **`@chat` 必须带来源群**：同一个 `@chat` 在不同 `source` 行里指向不同群，键必须是 `@chat:<source>`，否则策略互相覆盖。
2. **延后的周报不能用唤醒分钟当 `fireKey`**：必须用取材时刻，否则重启后同一周报算成不同事件、重复扣额。
3. **本地占额与外发非原子**：保证不超额，不承诺恰好一次；占额后崩溃会少发一条（可接受），反向不可接受。

## 10. 未决

- 是否需要「工作日」预设（当前用多个 `W` 窗口表达）。
- 抖动的随机间隔是否需要可配（当前固定 1–3 分钟）。
