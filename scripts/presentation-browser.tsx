import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AFTER_HOURS } from '../src/features/presentation/fixtures';
import { RehearsalSession } from '../src/features/presentation/rehearsal';
import { SetControlsPanel } from '../src/features/presentation/SetControlsPanel';
import { SetMenu } from '../src/features/presentation/SetMenu';
import '../src/App.css';

function Preview() {
  const [session, setSession] = useState(() => new RehearsalSession(AFTER_HOURS, undefined, 'prepare'));
  const dock = new URLSearchParams(location.search).get('dock') ?? 'right';
  const constrained = new URLSearchParams(location.search).has('constrained');
  return <main className="room" style={{ width: '100%', height: '100vh', overflow: 'auto', display: 'block', padding: 8 }}>
    <SetMenu session={session} onChange={doc => setSession(new RehearsalSession(doc, undefined, 'prepare'))} onControls={() => {}} />
    <section className="rm-panel rm-panel-setControls" data-in={dock} style={{ width: dock === 'bottom' ? '100%' : 'min(400px, 100%)', margin: '0 auto', background: '#101520', height: constrained ? dock === 'bottom' ? 220 : 'min(400px, calc(100vh - 16px))' : 'auto', overflow: 'hidden' }}>
      <div className="rm-panel-body" style={{ flex: constrained ? undefined : '0 0 auto' }}>
        <SetControlsPanel session={session} onChange={doc => setSession(new RehearsalSession(doc, undefined, 'prepare'))} />
      </div>
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Preview /></StrictMode>);
