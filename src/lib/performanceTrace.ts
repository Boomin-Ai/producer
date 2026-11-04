/** Opt-in, metadata-only frontend performance tracing. Never records UI text,
 * field values, element IDs/classes, URLs, IPC arguments/results, or errors.
 * Native consent is authoritative; localStorage is only a display mirror. */
export type PerformanceTraceConsent = { local: boolean; sharing: boolean };
export type TraceKind = 'session' | 'action' | 'span_start' | 'span_end' | 'ipc' | 'presentation_opportunity' | 'loop_lag' | 'observer' | 'room' | 'set' | 'native_metric';
export type TraceFields = Record<string, number | boolean>;
export type TraceContext = { roomVisit?: number };
type NativeConfig = { enabled: boolean; sharing?: boolean; sessionId?: string; version?: string; logicalCores?: number; sessionElapsedMs?: number; wallClockMs?: number; debugBuild?: boolean; sourceRevision?: string };
type NativeInvoke = (command: string, ...args: unknown[]) => unknown;
type NativeBridge = { invoke: NativeInvoke };
type ConfigSample = { config: NativeConfig; requestedAt: number; receivedAt: number };
type TraceEvent = { seq: number; atMs: number; kind: TraceKind; name: string; spanId?: string; actionId?: string; durationMs?: number; status?: string; fields?: TraceFields };
export type TraceSpan = Readonly<{ id: string; name: string; startedAt: number; actionId?: string; roomVisit?: number; generation: number }>;
type Capture = {
  generation: number; collectorId: string; sessionId: string; bridge: NativeBridge; original: NativeInvoke; wrapped: NativeInvoke;
  seq: number; actionSeq: number; spanSeq: number; queue: TraceEvent[]; dropped: number; stopped: boolean;
  currentAction?: string; actionTimer?: ReturnType<typeof setTimeout>; timer?: ReturnType<typeof setInterval>;
  raf?: number; presentations: { actionId: string; startedAt: number; roomVisit?: number }[];
  lastTick: number; lastIpcSummaryAt: number; elapsedOffsetMs: number; nativeClockAligned: boolean; clockUncertaintyMs: number; inFlight?: Promise<void>; click: (event: Event) => void; observers: PerformanceObserver[];
  otherListeners: { type: string; listener: (event: Event) => void }[]; inputs: Map<string, { target: string; count: number; roomVisit?: number }>; drag?: TraceSpan;
  ipcSummaries: Map<string, { name: string; count: number; sumDurationMs: number; maxDurationMs: number; roomVisit?: number }>;
};
const CONSENT_KEY = 'producer.performance-trace.consent';
const MAX_QUEUE = 512, MAX_BATCH = 64, MAX_PRESENTATIONS = 32, IPC_SUMMARY_WINDOW_MS = 5000;
let consent: Readonly<PerformanceTraceConsent> = Object.freeze({ local: false, sharing: false });
let active: Capture | undefined, nextGeneration = 0, consentEpoch = 0;
let initialized: Promise<() => void> | undefined, transition: Promise<void> = Promise.resolve();
let context: TraceContext = {};
const listeners = new Set<() => void>(), endedSpans = new WeakSet<TraceSpan>();
const now = () => performance.now();
const rounded = (value: number) => Math.round(value * 1000) / 1000;
const usableNativeClock = (config: NativeConfig) => typeof config.sessionElapsedMs === 'number' && Number.isFinite(config.sessionElapsedMs) && config.sessionElapsedMs >= 0 && config.sessionElapsedMs <= 1e15;
const bridge = (): NativeBridge | undefined => (window as Window & { __TAURI_INTERNALS__?: NativeBridge }).__TAURI_INTERNALS__;
const safeName = (name: unknown): name is string => typeof name === 'string' && name.length <= 160 && /^[a-zA-Z][a-zA-Z0-9_.:/|\[\]+-]*$/.test(name) && !name.includes('://');
function cleanFields(fields: TraceFields): TraceFields {
  const clean: TraceFields = {};
  for (const [key, value] of Object.entries(fields).slice(0, 16)) {
    const words = key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || /(^|_)(id|token|secret|url|path|email|text|label|value|args|result)(_|$)/.test(words)) continue;
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) clean[key] = value;
  }
  return clean;
}
function priority(event: Omit<TraceEvent, 'seq' | 'atMs'>): number {
  if (event.fields?.aggregated) return 0;
  if (event.name.startsWith('diagnostics.native_batch_')) return 2;
  if (['session', 'action', 'room', 'set', 'span_start', 'span_end', 'presentation_opportunity'].includes(event.kind)) return 2;
  return event.kind === 'ipc' || event.kind === 'observer' ? 1 : 0;
}
function append(capture: Capture, event: Omit<TraceEvent, 'seq' | 'atMs'>, traceContext: TraceContext = context) {
  if (capture !== active || capture.stopped) return;
  try {
    if (capture.queue.length >= MAX_QUEUE) {
      const level = priority(event);
      if (level === 0) { capture.dropped++; return; }
      let victim = capture.queue.findIndex(item => item.fields?.aggregated && level > 0);
      if (victim < 0) victim = capture.queue.findIndex(item => priority(item) < level);
      capture.dropped++;
      if (victim < 0) return;
      capture.queue.splice(victim, 1);
    }
    const fields = cleanFields(event.fields ?? {});
    if (traceContext.roomVisit !== undefined) fields.roomVisit = traceContext.roomVisit;
    fields.nativeClockAligned = capture.nativeClockAligned;
    fields.clockUncertaintyMs = capture.clockUncertaintyMs;
    capture.queue.push({ ...event, fields, seq: ++capture.seq, atMs: rounded(Math.max(0, now() + capture.elapsedOffsetMs)) });
  } catch { capture.dropped++; }
}
export function recordTraceEvent(name: string, fields: TraceFields = {}, kind: TraceKind = 'native_metric', traceContext: TraceContext = context): void {
  if (active && safeName(name)) append(active, { kind, name, fields, actionId: traceContext === context ? active.currentAction : undefined }, cleanContext(traceContext));
}
function cleanContext(next: TraceContext): TraceContext {
  return typeof next.roomVisit === 'number' && Number.isSafeInteger(next.roomVisit) && next.roomVisit >= 0 ? { roomVisit: next.roomVisit } : {};
}
export function setTraceContext(next: TraceContext): void { context = cleanContext(next); }
export function snapshotTraceContext(): Readonly<TraceContext> { return Object.freeze({ ...context }); }
export function startTraceSpan(name: string, fields: TraceFields = {}, traceContext: TraceContext = context): TraceSpan | undefined {
  if (!active || !safeName(name)) return;
  const span = Object.freeze({ id: active.collectorId + '-s' + ++active.spanSeq, name, startedAt: now(), actionId: traceContext === context ? active.currentAction : undefined, roomVisit: cleanContext(traceContext).roomVisit, generation: active.generation });
  append(active, { kind: 'span_start', name, spanId: span.id, actionId: span.actionId, fields }, span);
  return span;
}
export function endTraceSpan(span: TraceSpan | undefined, status: 'ok' | 'error' | 'cancelled' = 'ok', fields: TraceFields = {}): void {
  if (!span || !active || span.generation !== active.generation || endedSpans.has(span)) return;
  endedSpans.add(span);
  append(active, { kind: 'span_end', name: span.name, spanId: span.id, actionId: span.actionId, durationMs: rounded(Math.max(0, now() - span.startedAt)), status, fields }, span);
}
export function getPerformanceTraceConsent(): Readonly<PerformanceTraceConsent> { return consent; }
export function subscribePerformanceTraceConsent(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
function updateConsent(local: boolean, sharing: boolean) {
  sharing = local && sharing;
  if (consent.local === local && consent.sharing === sharing) return;
  consent = Object.freeze({ local, sharing });
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify(consent)); } catch { /* Native consent remains authoritative. */ }
  for (const listener of listeners) { try { listener(); } catch { /* Diagnostics never break a subscriber. */ } }
}
function stopCapture() {
  const capture = active;
  if (!capture) return;
  active = undefined; capture.stopped = true;
  clearInterval(capture.timer); clearTimeout(capture.actionTimer);
  document.removeEventListener('click', capture.click, true);
  for (const { type, listener } of capture.otherListeners) document.removeEventListener(type, listener, true);
  if (capture.raf !== undefined) cancelAnimationFrame(capture.raf);
  capture.observers.forEach(observer => observer.disconnect());
  try { if (capture.bridge.invoke === capture.wrapped) capture.bridge.invoke = capture.original; } catch { /* A host may make its bridge immutable. */ }
  capture.queue = []; capture.presentations = [];
}
function collectSummaries(capture: Capture, forceIpc = false) {
  for (const item of capture.inputs.values()) append(capture, { kind: 'action', name: 'ui.input:' + item.target, fields: { count: item.count, aggregated: true } }, item);
  capture.inputs.clear();
  const at = now(), windowMs = Math.max(0, at - capture.lastIpcSummaryAt);
  if (!forceIpc && windowMs < IPC_SUMMARY_WINDOW_MS) return;
  for (const item of capture.ipcSummaries.values()) append(capture, { kind: 'ipc', name: item.name, fields: { aggregated: true, windowMs: rounded(windowMs), count: item.count, sumDurationMs: rounded(item.sumDurationMs), maxDurationMs: rounded(item.maxDurationMs) } }, item);
  capture.ipcSummaries.clear();
  capture.lastIpcSummaryAt = at;
}
async function flush(capture: Capture): Promise<void> {
  if (capture.stopped || capture !== active) return;
  if (capture.inFlight) return capture.inFlight;
  collectSummaries(capture);
  if (!capture.queue.length && !capture.dropped) return;
  const events = capture.queue.splice(0, MAX_BATCH), droppedEvents = capture.dropped;
  capture.dropped = 0;
  const pending = (async () => {
    try {
      const receipt = await capture.original.call(capture.bridge, 'performance_trace_write', { batch: { schema: 'producer.performance-trace/1', sessionId: capture.sessionId, events, droppedEvents } }) as { accepted?: unknown; dropped?: unknown; enabled?: unknown } | null | undefined;
      const valid = receipt && Number.isSafeInteger(receipt.accepted) && Number.isSafeInteger(receipt.dropped) && typeof receipt.accepted === 'number' && receipt.accepted >= 0 && typeof receipt.dropped === 'number' && receipt.dropped >= 0 && receipt.accepted + receipt.dropped === events.length && typeof receipt.enabled === 'boolean';
      if (valid) {
        if (receipt.dropped as number > 0) append(capture, { kind: 'native_metric', name: 'diagnostics.native_batch_loss', fields: { submittedCount: events.length, acceptedCount: receipt.accepted as number, nativeDroppedCount: receipt.dropped as number, nativeEnabled: receipt.enabled as boolean } }, {});
      } else {
        // A successful write can have a missing/malformed receipt. Do not
        // retry (duplicates) or count it as an exact loss (it may be stored).
        capture.dropped = Math.min(Number.MAX_SAFE_INTEGER, capture.dropped + droppedEvents);
        append(capture, { kind: 'native_metric', name: 'diagnostics.native_batch_uncertain', fields: { submittedCount: events.length, unacknowledgedCount: events.length, receiptUncertain: true } }, {});
      }
    } catch {
      // The writer may have committed some/all events before an I/O or ACK
      // failure. Preserve known queue-drop metadata; mark event delivery
      // uncertain without retrying or fabricating an exact event-loss count.
      if (!capture.stopped) {
        capture.dropped = Math.min(Number.MAX_SAFE_INTEGER, capture.dropped + droppedEvents);
        append(capture, { kind: 'native_metric', name: 'diagnostics.native_batch_uncertain', fields: { submittedCount: events.length, unacknowledgedCount: events.length, receiptUncertain: true, writeFailed: true } }, {});
      }
    }
  })();
  capture.inFlight = pending;
  try { await pending; } finally { if (capture.inFlight === pending) capture.inFlight = undefined; }
}
/** Flush a bounded snapshot before a user-requested export, never an endless stream. */
export async function flushPerformanceTrace(): Promise<void> {
  const capture = active;
  if (!capture) return;
  if (capture.inFlight) await capture.inFlight;
  collectSummaries(capture, true);
  for (let index = 0, count = Math.max(capture.dropped ? 1 : 0, Math.ceil(capture.queue.length / MAX_BATCH)); index < count && capture === active; index++) await flush(capture);
}
function structuralTarget(target: EventTarget | null): string {
  let element = target instanceof Element ? target : null;
  for (let current = element, depth = 0; current && depth < 6; current = current.parentElement, depth++) {
    const action = current.getAttribute('data-perf-action');
    if (action && /^[a-z][a-z0-9_.:-]{0,63}$/.test(action)) return 'action:' + action;
  }
  const parts: string[] = [];
  for (let depth = 0; element && depth < 4; element = element.parentElement, depth++) {
    let index = 0, sibling = element.previousElementSibling;
    while (sibling && index < 32) { index++; sibling = sibling.previousElementSibling; }
    const tag = element.tagName.toLowerCase();
    parts.push((/^[a-z][a-z0-9-]{0,19}$/.test(tag) ? tag : 'element') + '[' + index + (sibling ? '+' : '') + ']');
  }
  return parts.reverse().join('/') || 'unknown';
}
function beginAction(capture: Capture, name: string, fields: TraceFields = {}): string {
  const actionId = capture.collectorId + '-a' + ++capture.actionSeq;
  capture.currentAction = actionId;
  clearTimeout(capture.actionTimer);
  // Clear at the next task, not a microtask between capture/bubble listeners.
  capture.actionTimer = setTimeout(() => { if (capture.currentAction === actionId) capture.currentAction = undefined; }, 0);
  append(capture, { kind: 'action', name, actionId, fields });
  return actionId;
}
function observe(capture: Capture, type: 'event' | 'longtask'): boolean {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes(type)) return false;
  try {
    const observer = new PerformanceObserver(list => {
      const entries = list.getEntries();
      capture.dropped += Math.max(0, entries.length - 32);
      for (const entry of entries.slice(0, 32)) {
        if (type === 'longtask') append(capture, { kind: 'observer', name: 'ui.long_task', durationMs: rounded(entry.duration) });
        else {
          const event = entry as PerformanceEventTiming;
          append(capture, { kind: 'observer', name: 'ui.event_timing', durationMs: rounded(event.duration), fields: { processingDelayMs: Math.max(0, event.processingStart - event.startTime), processingDurationMs: Math.max(0, event.processingEnd - event.processingStart) } });
        }
      }
    });
    observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 16 } : {}) });
    capture.observers.push(observer); return true;
  } catch { return false; }
}
function applyConfig(config: NativeConfig, requestedAt = now(), receivedAt = now()) {
  const native = bridge();
  if (!config.enabled || !native || typeof config.sessionId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(config.sessionId)) {
    stopCapture(); updateConsent(false, false); return;
  }
  updateConsent(true, config.sharing === true);
  if (active?.sessionId === config.sessionId) return;
  stopCapture();
  // Collector IDs prevent correlation collisions across opt-in toggles and
  // webview reloads while the native process keeps the same session ID.
  const collectorId = 'c-' + (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14));
  const nativeClockAligned = usableNativeClock(config);
  const capture: Capture = { generation: ++nextGeneration, collectorId, sessionId: config.sessionId, bridge: native, original: native.invoke, wrapped: native.invoke, seq: 0, actionSeq: 0, spanSeq: 0, queue: [], dropped: 0, stopped: false, presentations: [], lastTick: now(), lastIpcSummaryAt: now(), elapsedOffsetMs: nativeClockAligned ? config.sessionElapsedMs! - (requestedAt + receivedAt) / 2 : 0, nativeClockAligned, clockUncertaintyMs: Math.max(0, receivedAt - requestedAt) / 2, observers: [], otherListeners: [], inputs: new Map(), ipcSummaries: new Map(), click: () => {} };
  active = capture;
  capture.wrapped = function (this: unknown, command: string, ...args: unknown[]) {
    if (capture.stopped || capture !== active || typeof command !== 'string' || command.startsWith('performance_trace_')) return capture.original.call(this, command, ...args);
    const startedAt = now(), actionId = capture.currentAction, roomVisit = context.roomVisit;
    const name = safeName(command) ? command : 'unknown';
    const finish = (status: 'ok' | 'error') => {
      try {
        if (capture !== active || capture.stopped) return;
        const durationMs = Math.max(0, now() - startedAt);
        // Polling can exceed 100 calls/sec during preparation. Keep every
        // action-correlated, failed and >=50ms call; aggregate fast background
        // successes so status polling cannot drown out the user's actions.
        if (actionId || status === 'error' || durationMs >= 50) append(capture, { kind: 'ipc', name, actionId, status, durationMs: rounded(durationMs) }, { roomVisit });
        else {
          const key = name + '@' + (roomVisit ?? 'none');
          let item = capture.ipcSummaries.get(key);
          if (!item) {
            if (capture.ipcSummaries.size >= 32) { capture.dropped++; return; }
            item = { name, count: 0, sumDurationMs: 0, maxDurationMs: 0, roomVisit }; capture.ipcSummaries.set(key, item);
          }
          item.count++; item.sumDurationMs += durationMs; item.maxDurationMs = Math.max(item.maxDurationMs, durationMs);
        }
      } catch { /* Never reject a diagnostic continuation. */ }
    };
    try {
      const result = capture.original.call(this, command, ...args);
      // Observe without replacing the original promise/result/rejection.
      try { if (result && typeof (result as Promise<unknown>).then === 'function') void (result as Promise<unknown>).then(() => finish('ok'), () => finish('error')); else finish('ok'); } catch { /* Native return semantics win over diagnostics. */ }
      return result;
    } catch (error) { finish('error'); throw error; }
  };
  let ipcTiming = false;
  try { native.invoke = capture.wrapped; ipcTiming = native.invoke === capture.wrapped; } catch { /* Keep UI measurements if the host bridge is immutable. */ }
  capture.click = event => {
    if (!event.isTrusted || capture !== active) return;
    const startedAt = now(), roomVisit = context.roomVisit;
    const actionId = beginAction(capture, 'ui.click:' + structuralTarget(event.target), { hidden: document.visibilityState === 'hidden' });
    if (capture.presentations.length >= MAX_PRESENTATIONS) { capture.dropped++; return; }
    capture.presentations.push({ actionId, startedAt, roomVisit });
    if (capture.raf === undefined && typeof requestAnimationFrame === 'function') capture.raf = requestAnimationFrame(() => {
      capture.raf = undefined;
      for (const item of capture.presentations.splice(0)) append(capture, { kind: 'presentation_opportunity', name: 'ui.next_animation_frame', actionId: item.actionId, durationMs: rounded(Math.max(0, now() - item.startedAt)), status: 'observed' }, item);
    });
  };
  document.addEventListener('click', capture.click, { capture: true, passive: true });
  const listen = (type: string, listener: (event: Event) => void) => {
    capture.otherListeners.push({ type, listener }); document.addEventListener(type, listener, { capture: true, passive: true });
  };
  listen('input', event => {
    if (!event.isTrusted || capture !== active) return;
    const target = structuralTarget(event.target);
    const key = target + '@' + (context.roomVisit ?? 'none'), item = capture.inputs.get(key);
    if (item) item.count++;
    else if (capture.inputs.size < 16) capture.inputs.set(key, { target, count: 1, roomVisit: context.roomVisit });
    else capture.dropped++;
  });
  listen('change', event => {
    if (event.isTrusted && capture === active) beginAction(capture, 'ui.change:' + structuralTarget(event.target));
  });
  listen('dragstart', event => {
    if (!event.isTrusted || capture !== active) return;
    if (capture.drag) endTraceSpan(capture.drag, 'cancelled');
    beginAction(capture, 'ui.drag.start:' + structuralTarget(event.target));
    capture.drag = startTraceSpan('ui.drag:' + structuralTarget(event.target));
  });
  listen('drop', event => {
    if (!event.isTrusted || capture !== active) return;
    endTraceSpan(capture.drag); capture.drag = undefined;
    beginAction(capture, 'ui.drop:' + structuralTarget(event.target));
  });
  listen('dragend', event => {
    if (event.isTrusted && capture === active) { endTraceSpan(capture.drag, 'cancelled'); capture.drag = undefined; }
  });
  const eventTiming = observe(capture, 'event'), longTasks = observe(capture, 'longtask');
  append(capture, { kind: 'session', name: 'session.start', fields: { ipcTiming, debugBuildKnown: typeof config.debugBuild === 'boolean', ...(typeof config.debugBuild === 'boolean' ? { debugBuild: config.debugBuild } : {}), sourceRevisionAvailable: typeof config.sourceRevision === 'string' && /^[a-f0-9]{40}$/.test(config.sourceRevision), ...(typeof config.logicalCores === 'number' && Number.isFinite(config.logicalCores) ? { logicalCores: config.logicalCores } : {}), eventTiming, longTasks, animationFrame: typeof requestAnimationFrame === 'function', nativeClockAligned: Number.isFinite(config.sessionElapsedMs), configRoundTripMs: Math.max(0, receivedAt - requestedAt), frontendAnchorMs: (requestedAt + receivedAt) / 2, clockAnchorUncertaintyMs: Math.max(0, receivedAt - requestedAt) / 2, ...(typeof config.sessionElapsedMs === 'number' ? { nativeSessionAnchorMs: config.sessionElapsedMs } : {}), ...(typeof config.wallClockMs === 'number' ? { nativeWallClockAnchorMs: config.wallClockMs } : {}) } });
  capture.timer = setInterval(() => {
    if (capture !== active) return;
    const at = now();
    append(capture, { kind: 'loop_lag', name: 'ui.timer_lag', fields: { lagMs: rounded(Math.max(0, at - capture.lastTick - 1000)), hidden: document.visibilityState === 'hidden' } });
    capture.lastTick = at;
    const pending = capture.presentations.filter(item => at - item.startedAt >= 2000);
    capture.presentations = capture.presentations.filter(item => at - item.startedAt < 2000);
    for (const item of pending) append(capture, { kind: 'presentation_opportunity', name: 'ui.next_animation_frame', actionId: item.actionId, durationMs: rounded(at - item.startedAt), status: 'unobserved' }, item);
    void flush(capture);
  }, 1000);
}
async function readConfigSample(native: NativeBridge, isCurrent: () => boolean): Promise<ConfigSample> {
  const read = async (): Promise<ConfigSample> => {
    const requestedAt = now();
    const config = await native.invoke('performance_trace_config') as NativeConfig;
    return { config, requestedAt, receivedAt: now() };
  };
  const first = await read();
  if (first.config?.enabled !== true || !isCurrent()) return first;
  try {
    // The first response may wait for asynchronous native disk setup. A
    // single ready-state resample avoids retaining that startup RTT forever.
    const latest = await read();
    const sameScope = latest.config?.sessionId === first.config.sessionId && latest.config?.enabled === first.config.enabled && (latest.config?.sharing === true) === (first.config.sharing === true);
    const firstClockBetter = usableNativeClock(first.config) && (!latest.config || !usableNativeClock(latest.config) || first.receivedAt - first.requestedAt < latest.receivedAt - latest.requestedAt);
    if (sameScope && firstClockBetter) return { ...first, config: { ...latest.config, sessionElapsedMs: first.config.sessionElapsedMs, wallClockMs: first.config.wallClockMs } };
    return latest;
  } catch {
    // No fabricated fast anchor when the ready-state read fails.
    return first;
  }
}
export function initializePerformanceTrace(): Promise<() => void> {
  if (!initialized) {
    const epoch = consentEpoch;
    initialized = (async () => {
      try {
        const native = bridge();
        if (native) { const sample = await readConfigSample(native, () => epoch === consentEpoch); if (epoch === consentEpoch) applyConfig(sample.config, sample.requestedAt, sample.receivedAt); }
      } catch { /* Missing native support fails closed, without affecting startup. */ }
      return stopCapture;
    })();
  }
  return initialized;
}
export function setPerformanceTraceConsent(next: PerformanceTraceConsent): Promise<void> {
  const requested = { local: next.local === true, sharing: next.local === true && next.sharing === true }, epoch = ++consentEpoch;
  if (!requested.local) { stopCapture(); updateConsent(false, false); }
  const pending = transition.catch(() => {}).then(async () => {
    const native = bridge();
    if (!native) throw new Error('Performance monitoring is unavailable in this build.');
    // Keep pre-grant local aggregates on disk before native enrollment takes
    // its sharing cutoff. This does not grant permission to upload them.
    if (requested.sharing && !consent.sharing) await flushPerformanceTrace();
    await native.invoke('performance_trace_set_consent', requested);
    const sample = await readConfigSample(native, () => epoch === consentEpoch);
    if (epoch === consentEpoch) applyConfig(sample.config, sample.requestedAt, sample.receivedAt);
  });
  transition = pending;
  return pending;
}
