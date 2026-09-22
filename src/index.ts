/** Programmatic API. The CLI is built on exactly these modules. */
export { Project } from "./core/project.js";
export { TaskService, reduceTasks, type Task, type Session } from "./core/tasks.js";
export { EventStore } from "./core/store.js";
export { EVENT_TYPES, type AgentEvent, type EventType } from "./core/events.js";
export { reduceState, type WorkingState } from "./core/state.js";
export { buildRecovery, verifyRecovery, type RecoveryState, type Evidence } from "./core/recovery.js";
export { compactTask, recoverTask } from "./core/compact.js";
export { renderMarkdown } from "./core/render.js";
export { Checkpoints, type CheckpointMeta, type RestorePlan } from "./core/checkpoint.js";
export { buildChangeMap, type ChangeMap } from "./core/changes.js";
export { Redactor } from "./core/redact.js";
export { ProjectIndex } from "./index/indexer.js";
export { impact, overview, search } from "./index/analysis.js";
export type { AgentAdapter } from "./adapters/adapter.js";
export type { AIProvider } from "./ai/provider.js";
