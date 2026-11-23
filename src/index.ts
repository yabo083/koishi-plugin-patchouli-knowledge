/**
 * Patchouli Knowledge (不动的大图书馆)
 * 东方幻想乡·帕秋莉·诺蕾姬：基于自适应频率触发的迟智群聊思维碰撞沉淀与 llmwiki 知识库插件
 */

export * from './types';
export * from './trigger/baseline';
export * from './trigger/detector';
export * from './trigger/tuning';
export * from './trigger/potential';
export * from './trigger/boundary';
export * from './judge/client';
export * from './dispatcher/prompts';
export * from './dispatcher/dispatcher';
export * from './wiki/layout';
export * from './wiki/engine';
export * from './wiki/discard-dump';
export * from './wiki/storage';
export * from './wiki/topics';
export * from './wiki/public-view';
export * from './wiki/mask';
export * from './plugin/index';
export * from './plugin/rich-message';
export * from './plugin/media-registry';
export * from './plugin/card';
export * from './plugin/card-settings';
export * from './plugin/delivery';
export * from './plugin/topic-scheduler';
export * from './plugin/albums';
export * from './plugin/scribe';
export * from './plugin/weekly-schedule';
export * from './plugin/weekly-album';
export * from './web/api';
export * from './web/media-proxy';
export * from './telemetry/ring-buffer';
export * from './telemetry/ledger';
export * from './telemetry/inspector';
// 遥测契约按名导出：`isRecord` / `isFiniteNumber` 是子系统内部守卫，不作为公共 API 外泄。
export type {
  BaselineLedgerSnapshot,
  ChannelTelemetrySnapshot,
  GateStatus,
  MomentumMetrics,
  TelemetryCounters,
  TelemetryData,
  TelemetryEventKind,
  TelemetryScalar,
  TelemetrySnapshot,
  TelemetryTrace,
} from './telemetry/types';
export {
  BASELINE_LEDGER_EVENT_CAPACITY,
  BASELINE_LEDGER_WINDOW_MS,
  createEmptyGate,
  createEmptyTelemetrySnapshot,
  createTelemetryCounters,
  MOMENTUM_EPSILON,
  MOMENTUM_RSI_PERIOD,
  NEAR_MISS_COOLDOWN_MS,
  NEAR_MISS_RATE_RATIO,
  TELEMETRY_CHANNEL_TRACE_CAPACITY,
  TELEMETRY_EPSILON,
  TELEMETRY_EVENT_KINDS,
  TELEMETRY_TRACE_CAPACITY,
} from './telemetry/types';

import { name, Config, inject, apply, schema, reusable, PluginOptions, PatchouliKnowledgeSystem } from './plugin/index';

// 绝对不要 `export default apply`：`@koishijs/loader` 的 `unwrapExports` 是
// `module?.default || module`，一旦存在 default，loader 拿到的是**裸 apply 函数**，
// `reusable` / `Config` / `inject` / `name` 全部丢失 → `isForkable=false`：控制台黄条
// 常驻、状态点不跟随、启停作用在共享 runtime 上（ADR-023）。
// 官方插件的 esbuild 产物都是命名空间导出，没有 default——这里跟随同一形状。
export { name, Config, schema, inject, apply, reusable, PluginOptions, PatchouliKnowledgeSystem };
