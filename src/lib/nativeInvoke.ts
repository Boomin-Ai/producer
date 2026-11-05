/** Application-owned IPC boundary. Tauri's internal invoke is immutable.
 * SDK/plugin-internal calls do not pass through this adapter. */
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core';
export * from '@tauri-apps/api/core';

export type NativeInvokeObserver = (command: string) => ((status: 'ok' | 'error') => void) | undefined;
let observer: NativeInvokeObserver | undefined;

/** A diagnostics observer may observe metadata without replacing IPC results. */
export function observeNativeInvoke(next: NativeInvokeObserver): () => void {
  const previous = observer;
  observer = next;
  return () => { if (observer === next) observer = previous; };
}

export function invoke<T>(this: unknown, command: string, _args?: InvokeArgs, _options?: InvokeOptions): Promise<T> {
  const observe = observer;
  if (!observe || typeof command !== 'string' || command.startsWith('performance_trace_')) return Reflect.apply(tauriInvoke, this, arguments);
  let finish: ReturnType<NativeInvokeObserver>;
  try { finish = observe(command); } catch { /* Diagnostics never change IPC behavior. */ }
  if (!finish) return Reflect.apply(tauriInvoke, this, arguments);
  const complete = (status: 'ok' | 'error') => { try { finish?.(status); } catch { /* Preserve the original result/rejection. */ } };
  try {
    const result = Reflect.apply(tauriInvoke, this, arguments) as Promise<T>;
    try {
      if (result && typeof result.then === 'function') void result.then(() => complete('ok'), () => complete('error'));
      else complete('ok');
    } catch { /* A nonstandard thenable cannot alter the original return value. */ }
    return result;
  } catch (error) { complete('error'); throw error; }
}
