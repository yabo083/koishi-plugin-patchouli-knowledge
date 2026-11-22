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
export * from './web/ui';
export * from './web/api';
export * from './web/media-proxy';
export * from './web/tactical-dock';
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

import { name, Config, inject, apply, schema, PluginOptions, PatchouliKnowledgeSystem } from './plugin/index';

export { name, Config, schema, inject, apply, PluginOptions, PatchouliKnowledgeSystem };
export default apply;
