import { useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { activeEndpointId } from '../lib/workspace';
import { flushPerformanceTrace, getPerformanceTraceConsent, setPerformanceTraceConsent, subscribePerformanceTraceConsent } from '../lib/performanceTrace';

/** Diagnostics consent is separate from account and broadcast controls. */
export function PerformanceDiagnostics() {
  const consent = useSyncExternalStore(subscribePerformanceTraceConsent, getPerformanceTraceConsent, getPerformanceTraceConsent);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await work(); } catch { setMessage('Diagnostics could not complete. Your room and output are unchanged.'); }
    finally { setBusy(false); }
  };
  return <section className="set-diagnostics" aria-label="Performance diagnostics">
    <div className="cr-label set-gap">PERFORMANCE DIAGNOSTICS</div>
    <label><input type="checkbox" checked={consent.local} disabled={busy} onChange={event => {
      const local = event.currentTarget.checked;
      const endpointId = activeEndpointId();
      void run(async () => {
        await setPerformanceTraceConsent({ local, sharing: local && consent.sharing });
        if (!local && consent.sharing) await invoke('performance_trace_revoke', { endpointId: endpointId ?? '' });
      });
    }} /> Record performance on this device</label>
    <p>Records action timings, room loading, frame health and resource counters. It does not record media, typed text, names, links, clipboard contents or keys.</p>
    <label><input type="checkbox" checked={consent.sharing} disabled={busy || !consent.local} onChange={event => {
      const sharing = event.currentTarget.checked;
      void run(async () => {
        const endpointId = activeEndpointId();
        if (sharing && !endpointId) { setMessage('Connect your Boomin account before sharing diagnostics.'); return; }
        await setPerformanceTraceConsent({ local: consent.local, sharing });
        if (sharing) {
          try {
            const result = await invoke<{ available: boolean }>('performance_trace_configure_sharing', { endpointId });
            if (!result.available) { await setPerformanceTraceConsent({ local: consent.local, sharing: false }); setMessage('Sharing is not available yet. Your capture remains on this device.'); }
          } catch (error) { await setPerformanceTraceConsent({ local: consent.local, sharing: false }); throw error; }
        } else await invoke('performance_trace_revoke', { endpointId: endpointId ?? '' });
      });
    }} /> Allow sharing performance diagnostics with Boomin</label>
    <div className="set-diagnostics-actions">
      <button disabled={busy} onClick={() => void run(async () => {
        await flushPerformanceTrace();
        const path = await save({ defaultPath: 'producer-performance.json', filters: [{ name: 'Performance trace', extensions: ['json'] }] });
        if (!path) return;
        await invoke('performance_trace_save_export', { path });
        setMessage('Performance trace exported.');
      })}>Export capture</button>
      <button disabled={busy || !consent.local || !consent.sharing || !activeEndpointId()} onClick={() => void run(async () => {
        const endpointId = activeEndpointId();
        if (!endpointId) return;
        await flushPerformanceTrace();
        const result = await invoke<{ accepted: number; available: boolean }>('performance_trace_upload', { endpointId });
        setMessage(result.available ? `Shared ${result.accepted} performance events.` : 'Sharing is not available yet. Your capture remains on this device.');
      })}>Share capture</button>
    </div>
    <p role="status" aria-live="polite">{message || (consent.local ? 'Local capture is on. Shared events are sent in bounded batches only after you opt in.' : 'Diagnostics are off. Local captures are bounded and can be exported for review.')}</p>
  </section>;
}
