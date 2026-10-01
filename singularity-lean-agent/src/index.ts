/**
 * singularity-lean-agent — the library surface.
 *
 * Stable within lean-link/1: the wire types and encodings (`wire.ts`), the
 * node gate and client acceptance (`node.ts`, `client.ts`), and the relay
 * envelope (`relay.ts`). A change to any encoding is a new link version, not
 * a patch; `vectors/link-v1.json` is the record of what v1 means.
 */
export * from './wire.js';
export * from './node.js';
export * from './client.js';
export * from './relay.js';
export { checkFile, checkSource, toolchain, parseAxioms, declaredTheorems, type CheckResult, type Diagnostic } from './lean.js';
export { stageWorker, buildStage, buildOrder, type BuildReport, type Stage } from './worker.js';
export { LeanRuntime } from './runtime.js';
export { createNodeServer, callNode, CallError } from './http.js';
export { readTasks, type TaskSummary } from './tasks.js';
export { TOOLS, TOOLS_BY_NAME, toTaskResult } from './tools.js';
export { VERSION } from './version.js';
