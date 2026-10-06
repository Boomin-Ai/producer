import { useEffect, useState, useSyncExternalStore } from 'react';
import { evaluate, RehearsalSession, voteLeaders } from './rehearsal';
import { RehearsalPreview } from './RehearsalPreview';
import { rundown, timeLabel } from './rundown';
import type { PresentationPackage, SetControl } from './schema';
import type { SetOutputControls } from './useSetOutput';
import './presentation.css';

export function SetControlsPanel({ session, blocked = false, blockedReason, onChange, output }: {
  output?: SetOutputControls; session: RehearsalSession; blocked?: boolean; blockedReason?: string; onChange: (doc: PresentationPackage) => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const [error, setError] = useState('');
  const [player, setPlayer] = useState('player-1');
  // Fast Refresh can retain a session built by the previous runtime module.
  // Replace that rehearsal instance while retaining its prepared configuration.
  const staleSession = !(session instanceof RehearsalSession);
  useEffect(() => {
    if (staleSession) onChange((session as RehearsalSession).exportPreparedPackage());
  }, [staleSession, session, onChange]);
  if (staleSession) return <div className="set-controls"><p role="status">Updating rehearsal controls…</p></div>;
  const doc = session.package;
  const rehearsing = state.workspaceMode === 'rehearsal';
  const showControls = doc.set.controls.filter(c => c.type === 'button' && c.action.type.startsWith('show.'));
  const layoutControls = doc.set.controls.filter(c => c.type === 'button' && !c.action.type.startsWith('show.'));
  const fields = doc.set.controls.filter(c => c.type !== 'button');
  const stopped = !state.running && state.trace.some(entry => entry.message === 'Show started in rehearsal.');
  const phase = doc.show?.phases.find(p => p.id === (state.running ? state.show.phase : doc.show?.initialPhase));
  const nextPhase = doc.show?.phases.find(p => p.id === phase?.next);
  const schedule = rundown(doc);
  const stepIndex = schedule.phases.findIndex(p => p.id === state.show.phase);
  const displayedStepIndex = schedule.phases.findIndex(p => p.id === phase?.id);
  const runStatus = state.running ? state.paused ? 'Paused' : 'Running' : stopped ? 'Run stopped' : rehearsing ? 'Ready to rehearse' : 'Ready to rehearse show';
  const needsRevealHint = state.running && !state.paused && phase?.collectMs && !state.show.collecting && !state.show.revealed;
  const collecting = state.running && !!phase?.collectMs && state.show.collecting;
  const tied = state.show.total > 0 && voteLeaders(state).length > 1;
  const unresolved = state.running && !!phase?.collectMs && !state.show.collecting && !state.show.revealed;
  const resultLabel = state.show.result === 'draw' ? 'Draw · No winner awarded' : `Winner · ${state.show.winner}`;
  const segmentControls = showControls.filter(c => c.type === 'button' &&
    (c.action.type === 'show.reveal' ? unresolved && !tied : ['show.reopen', 'show.tiebreak', 'show.draw'].includes(c.action.type) ? false :
      ['show.vote', 'show.react'].includes(c.action.type) && collecting));
  const runControls = showControls.filter(c => c.type === 'button' &&
    (c.action.type === 'show.start' ? !state.running : c.action.type === 'show.next' && state.running && !!phase?.next &&
      !state.show.collecting && (!phase.collectMs || state.show.revealed)));
  const hint = tied ? 'Tied vote. Reopen voting, start a fresh tie-break, or reveal a draw to continue.' : state.show.total ? 'Voting is closed. Reveal the winner or reopen voting.' : 'No votes yet. Reopen voting to collect responses.';
  function renderControl(c: SetControl) {
    if (c.when !== undefined && !evaluate(c.when, state)) return null;
    if (c.type === 'button') {
      let disabled = blocked || c.enabled !== undefined && !evaluate(c.enabled, state);
      if (c.action.type === 'show.start') disabled ||= state.running;
      if (c.action.type === 'show.next') disabled ||= !state.running || state.paused || state.show.collecting ||
        !doc.show?.phases.find(p => p.id === state.show.phase)?.next ||
        !!doc.show.phases.find(p => p.id === state.show.phase)?.collectMs && !state.show.revealed;
      if (c.action.type === 'show.reveal') disabled ||= !state.running || state.paused || state.show.collecting || state.show.revealed || !state.show.total;
      return <button key={c.id} className={c.action.type.startsWith('show.') ? 'set-show-action' : undefined}
        aria-label={c.label} aria-pressed={c.action.type === 'layout.select' ? state.layoutId === c.action.layoutId : undefined} disabled={disabled} onClick={() => session.send({ type: 'control', action: c.action })}>
        {c.label}</button>;
    }
    const def = doc.set.values[c.key];
    return <label key={c.id}>{c.label}<input aria-label={c.label} type={c.type === 'number' ? 'number' : 'text'}
      disabled={blocked} value={String(state.values[c.key])} maxLength={def.type === 'text' ? def.maxLength : undefined}
      min={def.type === 'number' ? def.min : undefined} max={def.type === 'number' ? def.max : undefined}
      onChange={e => session.send({ type: 'field', key: c.key, value: c.type === 'number' ? Number(e.target.value) : e.target.value })} /></label>;
  }
  function control(c: SetControl) {
    try { return renderControl(c); }
    catch { return <span key={c.id} className="set-error">{c.label}: binding unavailable.</span>; }
  }
  if (blocked) return <div className="set-controls"><p>{blockedReason ?? 'Waiting for the room to finish loading.'}</p></div>;
  return <div className="set-controls">
    <header className="set-controls-toolbar">
      <div className="set-header-main">
      <span className={`set-mode-badge ${rehearsing ? 'rehearsal' : 'prepared'}`}>{rehearsing ? 'Rehearsal' : 'Prepared'}</span>
      <strong className="set-current-name">{doc.name}</strong>
      </div>
      <div className="set-header-mode">
      <span className="set-capability">{doc.show ? "Show attached" : "Set only"}</span>
      <button className="set-mode-action" onClick={() => {
        setError(''); setPlayer('player-1');
        if (rehearsing) session.exitRehearsal(); else session.enterRehearsal();
      }}>{rehearsing ? 'Exit rehearsal' : 'Rehearse'}</button>
      {rehearsing && <button aria-label="Reset" onClick={() => session.send({ type: 'reset' })}>Reset rehearsal</button>}
      </div>
      {output && <div className="set-output-actions">
        {output.active || output.busy ? <button onClick={() => void output.returnToRoom()}>Return to room</button> : <button disabled={rehearsing || output.busy} onClick={() => void output.apply()}>Apply set</button>}
        <span>{output.busy ? 'Preparing output…' : output.active ? 'On output' : 'Room output'}</span>
      </div>}
      <div className="set-toolbar-tools">
        <RehearsalPreview doc={doc} state={state} />
      </div>
    </header>
    {output?.error && <div role="alert" className="set-error">{output.error} <button disabled={output.busy || rehearsing} onClick={()=>void output.apply()}>Retry update</button></div>}
    {error && <p role="alert" className="set-error">{error}</p>}
    {state.trace[state.trace.length - 1]?.message.startsWith('Rejected:') && <p role="status" className="set-error">{state.trace[state.trace.length - 1]!.message}</p>}
    <div className={`set-sections ${rehearsing ? 'is-rehearsing' : 'is-prepared'}${doc.show ? ' has-show' : ''}`}>
      {!doc.show && <section className="set-workspace" aria-label="Set workspace">
        <h3>Layout <span>{rehearsing ? 'Rehearsal' : 'Prepared'}</span></h3>
        <div className="set-controls-fields set-layout-controls">{layoutControls.map(control)}</div>
        <p className="set-rehearsal-note">{doc.set.slots.length} source slots · {fields.length} editable fields</p>
      </section>}
      {doc.show && <section className="set-run" aria-label="Run">
        <div className="set-run-transport">
          <div className="set-run-topline">
            <h3>Show run<span>{rehearsing ? 'Rehearsal' : 'Prepared'}</span></h3>
            <span role="status" className={`set-run-status${state.running ? state.paused ? ' is-paused' : ' is-running' : ''}`}>{runStatus}</span>
          </div>
          {doc.show ? <>
            <div className="set-run-overview">
              <div className="set-run-description">
                <div className="set-simulation-state" role="status">
                  <div className="set-current-segment-row"><h4 className="set-current-segment">{phase?.label}</h4>
                    {state.show.collecting && <span className="set-segment-countdown">{timeLabel(state.show.remainingMs)} <small>left</small></span>}</div>
                </div>
                <p className="set-next-step">{nextPhase ? `Up next: ${nextPhase.label}` : 'Final step'}</p>
              </div>
            </div>
            <div className="set-run-actions">
            {rehearsing && !state.running && <div className="set-run-start">{runControls.map(control)}</div>}
            {rehearsing && state.running && <div className="set-controls-fields">{runControls.map(control)}
              {state.running && <><button onClick={() => session.send({ type: 'pause', paused: !state.paused })}>{state.paused ? 'Resume' : 'Pause'}</button>
                <button onClick={() => session.send({ type: 'stop' })}>Stop run</button></>}
            </div>}
            <span className="set-segment-position">Segment {displayedStepIndex + 1}/{schedule.phases.length}</span>
            </div>
            {!rehearsing && <p className="set-rehearsal-note">Rehearse to practice this show. Live show output is not connected yet.</p>}
          </> : <><strong>Set rehearsal</strong><p className="set-rehearsal-note">Try layouts and content here. Test data is in Set settings.</p></>}
        </div>
        {doc.show && <>
          <div className="set-segments" role="region" aria-label="Show segments">
            <h3 className="set-segments-heading">Segments</h3>
            <div className="set-segments-scroll" role="region" tabIndex={0} aria-label="Segment list">
              <ol>{schedule.phases.map((p, i) => <li key={p.id} aria-current={state.running && i === stepIndex ? 'step' : undefined}
                className={state.running && i === stepIndex ? 'current' : state.running && i < stepIndex ? 'passed' : ''}>
                <span className="set-step-number">{i + 1}</span><span>{p.label}</span><small>{p.collectMs ? `${timeLabel(p.collectMs)} vote` : 'Manual'}</small>
              </li>)}</ol>
              <div className="set-run-timing">
                <span className="set-rehearsal-note">{schedule.repeats ? 'Repeating · No fixed total' : schedule.timedMs ? `${timeLabel(schedule.timedMs)} timed${schedule.manual ? ' + manual steps' : ''}` : 'Manual timing'}</span>
                {rehearsing && <span className="set-rehearsal-note">Elapsed {timeLabel(state.elapsedMs)} · Simulated clock</span>}
              </div>
            </div>
          </div>
        </>}
      </section>}
      {rehearsing && doc.show && <section className="set-participation" aria-label="Participation">
        <h3>Segment controls <span>Rehearsal</span></h3>
        <strong className="set-participation-heading">{phase?.label}</strong>
        {collecting ? <>
          <div className="set-participation-stats" role="status">{state.show.ballot > 1 ? `Tie-break ${state.show.ballot - 1} · ` : ''}{state.show.total} votes · heat {Math.round(state.show.heat * 100)}%</div>
          <div className="set-controls-fields">
            <input aria-label="Simulated player" value={player} maxLength={40} onChange={e => setPlayer(e.target.value)} />
            <button onClick={() => setPlayer(`player-${Number(player.match(/^player-(\d+)$/)?.[1] ?? state.show.total) + 1}`)}>New participant</button>
          </div>
          <div className="set-controls-fields">
            {doc.show.choices.filter(choice => state.ballotChoiceIds.includes(choice.id)).map(choice => <button key={choice.id} disabled={state.paused}
              onClick={() => session.send({ type: 'vote', playerId: player, choiceId: choice.id })}>Vote {choice.label}</button>)}
            <button disabled={state.paused} onClick={() => session.send({ type: 'reaction', playerId: player })}>React 🔥</button>
          </div>
          <div className="set-controls-fields">
            <button disabled={state.paused} onClick={() => session.send({ type: 'tick', milliseconds: 10_000 })}>Advance 10s</button>
            <button disabled={state.paused} onClick={() => session.send({ type: 'tick', milliseconds: state.show.remainingMs })}>Close voting</button>
          </div>
          <span className="set-rehearsal-note">{timeLabel(state.show.remainingMs)} left · Simulated clock</span>
        </> : state.running && phase?.collectMs ? <>
          <div className="set-participation-stats" role="status">Voting closed · {state.show.total} votes</div>
          <ul className="set-vote-results">{doc.show.choices.map(choice => <li key={choice.id}><span>{choice.label}</span><strong>{state.counts[choice.id]}</strong></li>)}</ul>
          {state.show.revealed ? <strong className="set-segment-result">{resultLabel}</strong> : needsRevealHint && <p className="set-rehearsal-note">{hint}</p>}
        </> : state.running && state.show.revealed ? <>
          <strong className="set-segment-result">{resultLabel}</strong>
          <p className="set-rehearsal-note">The result is on the set output. Stop the run when you’re finished.</p>
        </> : <p className="set-rehearsal-note">No participant inputs in this segment. {state.running ? 'Use Next when you’re ready.' : 'Start the show to rehearse this segment.'}</p>}
        {unresolved && <div className="set-controls-fields">
          <button disabled={state.paused} onClick={() => session.send({ type: 'control', action: { type: 'show.reopen' } })}>Reopen voting</button>
          {tied && <>
            <button disabled={state.paused} onClick={() => session.send({ type: 'control', action: { type: 'show.tiebreak' } })}>Start tie-break</button>
            <button className="set-show-action" disabled={state.paused} onClick={() => session.send({ type: 'control', action: { type: 'show.draw' } })}>Reveal draw</button>
          </>}
          <p className="set-rehearsal-note">Reopen adds {timeLabel(phase?.collectMs ?? 0)} and keeps votes. A tie-break starts a new ballot.</p>
        </div>}
        {!!segmentControls.length && <div className="set-controls-fields">{segmentControls.map(control)}</div>}
      </section>}
      <div className="set-reference">
        <section className="set-setup" aria-label="Setup">
          <details key={`${state.sandboxId}-setup`} open={!rehearsing}><summary><strong>{doc.show ? 'Setup' : 'Set fields'}</strong><span>{doc.show ? 'Fields, layouts, sources' : `${fields.length} fields`}</span></summary>
            <p className="set-section-note">{rehearsing ? "Practice changes are discarded when you exit rehearsal." : "Edit values here. Change design with your agent."}</p>
            {doc.show && <div className="set-controls-fields set-layout-controls">{layoutControls.map(control)}</div>}
            <div className="set-controls-fields">{fields.map(control)}</div>
            <details className="set-source-slots"><summary>Source slots <span>{doc.set.slots.length}</span></summary>
              {output ? <div className="set-controls-fields">{doc.set.slots.map(slot => <label key={slot.id}>{slot.label}<select aria-label={`${slot.label} source`} disabled={rehearsing || output.busy} value={output.bindings[slot.id] ?? ''} onChange={e => output.bind(slot.id,e.target.value)}>
                <option value="">Empty slot</option>
                {(output.sources.items ?? []).filter(item => item.kind!=='mic').map(item => <option key={item.id} value={item.id} disabled={!item.visible || !item.has_frame}>{item.label}{!item.visible ? ' · off scene' : !item.has_frame ? ' · waiting for video' : ''}</option>)}
              </select><SlotFramingControls label={slot.label} value={output.framing[slot.id] ?? findSlotFraming(doc.set.layouts.find(l=>l.id===state.layoutId)?.root,slot.id)} disabled={rehearsing || output.busy} onChange={value=>output.frame(slot.id,value)} /></label>)}</div> : <ul>{doc.set.slots.map(slot => <li key={slot.id}><strong>{slot.label}</strong><span>Sample video</span></li>)}</ul>}
              <p className="set-section-note">{output ? 'Assign sources already on the room output. Empty slots stay empty; audio follows the room mixer.' : 'This preview uses sample video.'}</p>
            </details>
          </details>
        </section>
        <p className="set-prepared-note">{rehearsing ? "Sample inputs only · Room output unchanged" : output ? output.active ? "Set is on the room output · Audio follows the room mixer" : "Prepare your sources, then Apply set" : "Prepared for preview and rehearsal · Live set output is not connected yet"}</p>
      </div>
    </div>
  </div>;
}

function findSlotFraming(node:import('./schema').PresentationNode|undefined,slot:string):import('./schema').SlotFraming {
  const search=(n:import('./schema').PresentationNode):import('./schema').SlotFraming|undefined=>n.slotId===slot?n.framing:n.children?.map(search).find(Boolean);
  return (node && search(node)) ?? {mode:'fit',x:0.5,y:0.5};
}
function SlotFramingControls({label,value,disabled,onChange}:{label:string;value:import('./schema').SlotFraming;disabled:boolean;onChange:(v:import('./schema').SlotFraming)=>void}) {
 return <span className="set-slot-framing"><select aria-label={`${label} framing`} disabled={disabled} value={value.mode} onChange={e=>onChange({...value,mode:e.target.value as 'fill'|'fit'})}><option value="fill">Fill frame</option><option value="fit">Fit entire source</option></select>{value.mode==='fill' && <><span>Crop position</span><span className="set-slot-position"><span>Horizontal<input aria-label={`${label} horizontal crop position`} type="range" min="0" max="1" step="0.01" value={value.x} disabled={disabled} onChange={e=>onChange({...value,x:Number(e.target.value)})} /></span><span>Vertical<input aria-label={`${label} vertical crop position`} type="range" min="0" max="1" step="0.01" value={value.y} disabled={disabled} onChange={e=>onChange({...value,y:Number(e.target.value)})} /></span></span><button type="button" disabled={disabled} onClick={()=>onChange({...value,x:0.5,y:0.5})}>Center crop</button></>}</span>;
}
