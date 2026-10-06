import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AFTER_HOURS, HEAD_TO_HEAD, SIGNAL_DESK } from './fixtures';
import { PackageAuthoringDialog, type AuthoringIntent } from './PackageAuthoringDialog';
import { RehearsalSession } from './rehearsal';
import type { PresentationPackage } from './schema';
import type { SetOutputControls } from './useSetOutput';
import './presentation.css';

export function SetMenu({ session, onChange, onControls, output }: {
  output?:SetOutputControls; session: RehearsalSession; onChange: (doc: PresentationPackage) => void; onControls: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const rehearsing = state.workspaceMode === 'rehearsal';
  const navLabel = rehearsing ? 'Exit rehearsal' : state.running ? 'Stop show' : output?.active ? `Set on: ${session.package.name}` : `Set: ${session.package.name}`;
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ top: 60, left: 8 });
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [authoring, setAuthoring] = useState<{ intent: AuthoringIntent; doc: PresentationPackage } | null>(null);
  const close = () => menu.current?.hidePopover();
  const edit = (intent: AuthoringIntent) => { close(); setAuthoring({ intent, doc: session.exportPreparedPackage() }); };
  async function importFile(input: File | undefined) {
    if (!input) return;
    try {
      if (input.size > 128_000) throw new Error('Set package exceeds 128 KB.');
      const next = new RehearsalSession(JSON.parse(await input.text()), undefined, 'prepare');
      onChange(next.package); setError(''); close(); onControls();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to import set.'); menu.current?.showPopover(); }
    finally { if (file.current) file.current.value = ''; }
  }
  return <>
    <div className="set-nav-controls">
    <button className={`hd-chip${rehearsing || state.running ? ' on' : ''}`}
      aria-label={rehearsing ? 'Exit rehearsal from top bar' : state.running ? 'Stop show from top bar' : 'Open set controls'}
      title={rehearsing ? 'Exit rehearsal and return to the prepared set' : state.running ? 'Stop the show' : 'Open set controls'}
      onClick={() => { close(); if (rehearsing) session.exitRehearsal(); else if (state.running) session.send({ type: 'stop' }); else onControls(); }}>{navLabel}</button>
    <button ref={trigger} className="hd-chip set-settings-trigger" popoverTarget={id} aria-label="Set settings" title="Set settings: choose, edit, import or export"
      onClick={() => { const rect = trigger.current!.getBoundingClientRect(); setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, innerWidth - 308)) }); }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m9.5 3-.5 2-2 .9-1.8-.6-2.5 4.3L4 11v2l-1.8 1.4 2.5 4.3 1.8-.6 2 .9.5 2h5l.5-2 2-.9 1.8.6 2.5-4.3L20 13v-2l1.8-1.4-2.5-4.3-1.8.6-2-.9-.5-2z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
    </div>
    {createPortal(<div ref={menu} id={id} className="set-menu" popover="auto" aria-label="Set menu options" style={position}>
      <label>Choose set<select aria-label="Choose set" value={[AFTER_HOURS.id, HEAD_TO_HEAD.id, SIGNAL_DESK.id].includes(session.package.id) ? session.package.id : 'imported'}
        onChange={e => { onChange(e.target.value === AFTER_HOURS.id ? AFTER_HOURS : e.target.value === SIGNAL_DESK.id ? SIGNAL_DESK : HEAD_TO_HEAD); close(); onControls(); }}>
        <option value={SIGNAL_DESK.id}>Signal Desk</option><option value={AFTER_HOURS.id}>After Hours</option><option value={HEAD_TO_HEAD.id}>Head to Head</option>
        {![AFTER_HOURS.id, HEAD_TO_HEAD.id, SIGNAL_DESK.id].includes(session.package.id) && <option value="imported">{session.package.name}</option>}
      </select></label>
      <button onClick={() => { close(); onControls(); }}>Open set controls</button>
      {output && <button disabled={!output.active && !output.busy && rehearsing} onClick={() => {close();void (output.active || output.busy ? output.returnToRoom() : output.apply());}}>{output.active || output.busy ? 'Return to room' : 'Apply set'}</button>}
      <div className="set-menu-agent"><button onClick={() => edit('edit-set')}>Edit set with agent</button>
        <button className="set-agent-help" aria-label="About editing sets and shows with an agent" aria-expanded={help} onClick={() => setHelp(!help)}>?</button></div>
      {help && <p>Edit the set design and optional show with an agent. Export your configured set and brief, then import the updated JSON and rehearse it.</p>}
      {!session.package.show && <button aria-haspopup="dialog" onClick={() => edit('add-show')}>Add show with agent</button>}
      <div className="set-menu-files"><button onClick={() => { setError(''); file.current?.click(); }}>Import JSON</button>
        <button onClick={() => edit('export')}>Export package</button></div>
      {error && <p role="alert">{error}</p>}
      {!!Object.keys(session.package.set.feeds).length && <details className="set-test-data"><summary>Test data</summary>
        <p>Manual inputs for data connected to this set, such as headlines or meters. These are simulated values, not guest video or audience responses.</p>
        {!rehearsing && <p>Enter rehearsal to test changes. Exiting rehearsal restores your prepared values.</p>}
        <div className="set-controls-fields">{Object.entries(session.package.set.feeds).map(([key, def]) => <label key={key}>{key}<input aria-label={`Test ${key}`} disabled={!rehearsing}
          type={def.type === 'number' ? 'range' : def.type === 'boolean' ? 'checkbox' : 'text'}
          value={def.type === 'boolean' ? undefined : String(state.feeds[key])} checked={def.type === 'boolean' ? !!state.feeds[key] : undefined}
          min={def.type === 'number' ? def.min : undefined} max={def.type === 'number' ? def.max : undefined} step="0.01"
          maxLength={def.type === 'text' ? def.maxLength : undefined}
          onChange={e => session.send({ type: 'feed', key, value: def.type === 'boolean' ? e.target.checked : def.type === 'number' ? Number(e.target.value) : e.target.value })} /></label>)}</div>
      </details>}
      <details className="set-trace"><summary>Activity</summary><ol>{state.trace.map((entry, i) => <li key={`${i}-${entry.at}`}>{Math.round(entry.at / 1000)}s · {entry.message}</li>)}</ol></details>
    </div>, document.body)}
    <input ref={file} className="set-file-input" type="file" accept=".json,application/json" aria-label="Import set package" onChange={e => void importFile(e.target.files?.[0])} />
    {authoring && <PackageAuthoringDialog {...authoring} returnFocus={trigger.current} onLoad={doc => { onChange(doc); onControls(); }} onClose={() => setAuthoring(null)} />}
  </>;
}
