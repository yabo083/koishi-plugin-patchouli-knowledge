# 定时投递与限量投递

> 状态：设计定稿，待实施。基于 `astra`（gpt-6.2-astra）评审稿 + 主代理取舍。
> gemini-3.8-flash 第二意见未取得（上游 503 ×2、agy 需 OAuth、本地 gemini-designer 模块缺失）。

## 1. 需求

订阅表增加两个维度，且不破坏现有四列语义（不开功能时行为完全不变）：

1. **定时投递**：某行的投递只在指定时间窗口发生。
2. **限量投递**：某行每个周期最多投 N 条。

## 2. 字段（行内，不用旁表）

与 astra 的差异：他提议第 5 列 `ruleId` + `settings.json` 旁表 `deliveryRules`。**改为行内两列**，理由是需求要求「与现有表格有机结合」，行内规则随行自然生命周期（删行即删规则、无悬空 ID、不需要第二编辑面、不需要唯一性校验）。

```ts
export interface SubscriptionRow {
  source: string;
  targets: string[];
  entry: boolean;
  weekly: boolean;
  /**
   * 投递窗口。空 = 不限时（保持现状）。
   * 语法：`* HH:MM-HH:MM`（每天）、`W HH:MM-HH:MM`（W=0..6，周一为 1）、`W HH:MM`
   * （该日一分钟窗口，等价 `W HH:MM-HH:MM+1m`）。左闭右开，跨午夜归开始日。
   */
  window?: string;
  /**
   * 周期额度。空 = 不限。语法 `<词条>/<周报>`，例 `3/1`；`0` 表示该类型不再投递。
   */
  quota?: string;
}
```

Koishi Schema：

```ts
window: Schema.string().default('')
  .description('投递窗口，如 * 22:00-23:00（每天）/ 1 09:00（周一）。空=不限时'),
quota: Schema.string().default('')
  .description('每周期上限，如 3/1（每日 3 条词条 / 每周 1 次周报）。空=不限'),
```

解析结果（归一阶段算好，运行期不再解析字符串）：

```ts
interface DeliveryPolicy {
  window: WindowSpec | null;   // { days: number[], startMin, endMin }
  entryPerDay: number;         // 0 = 无限
  weeklyPerWeek: number;       // 0 = 无限
}
```

## 3. 语义决策

| 问题 | 决策 | 理由 |
| --- | --- | --- |
| 窗口外发生了什么 | **排队**，到下一个窗口首刻投递 | 不让讨论结束时间决定词条是否可见；丢弃会静默改变用户预期 |
| 时区 | `Asia/Shanghai` 固定，用 `Intl.DateTimeFormat` 取本地时分，不手算偏移 | 单地域部署；`Intl` 自带夏令时正确性 |
| 窗口边界 | 左闭右开；跨午夜（`22:00-02:00`）归开始日 | 避免同一时刻被两个窗口认领 |
| 周报与窗口 | 周报仍由全局 cron 触发取材，产物进队列，到窗才发 | 取材时刻与投递时刻解耦，`fireKey` 保持取材时刻 |
| 限量口径 | 按**事件键**计数：词条 `entryId`、周报 `fireKey`；多目标不倍增 | 同一条词条投三个相册仍算一条 |
| 周期 | 词条按自然日（上海时区 00:00 切），周报按周一起算的自然周 | 与用户「一天/一周」的直觉一致 |
| 占额时机 | 渲染完成、首次发送前原子占额；失败不退 | 保证不超额；无法保证恰好一次（见坑 3） |
| 周期切换 | 惰性：读计数时比较 `periodKey`，不同则清零 | 不需要定时器 |
| AIMD 调参 | 不接额度 | 额度是投递策略，不是触发阈值 |

## 4. 状态文件

`.patchouli/delivery-state.json`（与 `settings.json` 同目录，独立文件、独立原子写、`0600`）：

```ts
interface DeliveryState {
  version: 1;
  queue: QueuedDelivery[];              // ≤1024 条，序列化后 ≤1 MiB
  counters: Record<string, Counter>;     // 键 = `${source}\u0000${ruleKey}`
}
interface QueuedDelivery {
  seq: number;            // 单调递增，FIFO
  source: string;         // 来源群
  targets: string[];      // 快照（名字 → 投递时再解析成稳定地址）
  kind: 'entry' | 'weekly';
  key: string;            // entryId | fireKey（幂等键）
  createdAt: number;      // 原始发生时刻
  channelId: string;
}
interface Counter { periodKey: string; used: number }
```

超限策略：队列满（1024 条或 1 MiB）时**拒收新事件并 warn**，不淘汰旧项——旧项是用户已经等着的产出，淘汰等于静默丢投递。

读盘时：坏文件当空状态 + warn（不覆盖原文件，写路径拒绝，沿用 `settings-store` 对 `SettingsDocumentError` 的处理方式）。

## 5. 改动点

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `SubscriptionRow` 增 `window?` / `quota?` |
| `src/plugin/subscriptions.ts` | `normalizeSubscriptionRows` 归一两个新字段（非法值清空并计入 `warnings`）；`validateSubscriptionRows` 校验语法；`compileSubscriptions` 输出 `policy: DeliveryPolicy` |
| `src/plugin/delivery-gate.ts`（新） | `DeliveryGate`：`offer(event)`、`drain(now)`、`nextWakeAt(now)`、`dispose()`；内部单定时器，按 `nextWakeAt` 睡到窗口首刻 |
| `src/plugin/delivery-state.ts`（新） | 队列与计数的读写、上限、`periodKey` 计算、原子写、串行队列 |
| `src/plugin/index.ts` | `handleQuiescence` 结算后改为 `gate.offer({kind:'entry',...})`；`runWeeklyAlbumUpload` 产物同样 `offer`；`dispose()` 里 `gate.dispose()` |
| `src/plugin/weekly-album.ts` | `planWeeklyAlbumSources` 只返回 `weekly` 且通过额度检查的行（读取时预检，最终以占额为准） |
| `src/plugin/settings-store.ts` | 无改动（规则在行里，随 `subscriptions` 一起落盘） |
| `src/plugin/README.md` / `tests/test-suite.md` | 新增契约与用例表 |

不动的部分：`registerWeeklyCron`（仍按全局 cron 触发取材）、`TopicScheduler`、`applySettingsOverrides`、触发器状态机。

## 6. 测试矩阵

| 用例 | 断言 |
| --- | --- |
| `SCHED-01` 空表/旧表 | 无 `window`/`quota` 时投递路径与现网一致，`offer` 直通 |
| `SCHED-02` 窗口内 | 事件在窗口内 → 立即投递，队列不增长 |
| `SCHED-03` 窗口外排队 | 事件在窗口外 → 入队、不投；到窗口首刻由定时器投出 |
| `SCHED-04` 跨午夜窗口 | `22:00-02:00` 的 01:30 属开始日窗口内 |
| `SCHED-05` 限量 | `quota=2/1`，第 3 条词条同日内被丢弃并 warn |
| `SCHED-06` 多目标不倍增 | 同 `entryId` 投 3 个相册只扣 1 次额度 |
| `SCHED-07` 周期滚动 | 跨自然日/周后计数清零 |
| `SCHED-08` 跨重启 | 队列与计数持久化，重启后继续；同 `key` 不重复扣额 |
| `SCHED-09` 队满 | 第 1025 条被拒并 warn，旧项保留 |
| `SCHED-10` 坏状态文件 | 当空状态处理 + 一次 warn，文件不被覆盖 |
| `SCHED-11` 并发 offer | 同一 `key` 并发到达只入队一次 |
| `SCHED-12` dispose | 卸载后定时器停止、不再发送 |
| `SCHED-13` 目标失效 | 队列项在投递时目标已掉绑 → 丢弃该目标并 warn（沿用绑定表语义） |

## 7. 三个坑（来自 astra，已确认成立）

1. **行身份会被聚合抹平**：`entryTargetsFor` 与周报按来源聚合目标时，若两行同 `source` 而策略不同，需要按「来源 + 策略」而不是按来源聚合；幂等键用目标级 `entryId` 兜底。
2. **延后的周报不能用唤醒分钟作 `fireKey`**：`fireKey` 必须是取材时刻，否则重启后同一周报会被算成不同事件、重复扣额或重复投递。
3. **本地占额与外发不是原子提交**：保证「不超额」，不承诺「恰好一次」。占额后进程崩溃会少发一条——可接受，反向（多发）不可接受。

## 8. 未决

- 窗口语法是否需要支持 `HH:MM` 单点（当前按一分钟窗口处理）。
- 是否需要「仅工作日」这类预设——先用 `W` 逐日落多个窗口解决，不做预设。
