import type { ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { version } from '../../package.json';
import './entry.css';

type EntryStage = 'welcome' | 'access' | 'signin';
const stages: { id: EntryStage; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'access', label: 'Permissions' },
  { id: 'signin', label: 'Sign in' },
];

/** Shared first-run chrome. Static artwork never opens capture or an engine. */
export function EntryFrame({ children, stage = 'signin' }: { children: ReactNode; stage?: EntryStage }) {
  const current = stages.findIndex(item => item.id === stage);
  return (
    <section className={`entry-shell entry-stage-${stage}`} aria-label="Producer setup">
      <header className="entry-header" data-tauri-drag-region>
        <div className="entry-identity">
          <img src="/brand/producer-mark.png" width="36" height="36" alt="" />
          <span>Producer</span><span className="entry-beta">Beta</span>
        </div>
        <span className="entry-network">by Boomin</span>
      </header>
      <div className="entry-workspace">
        <aside className="entry-story" aria-label="Producer studio">
          <div className="entry-story-copy">
            <span className="entry-eyebrow">Your desktop studio</span>
            <h2>Stop posting.<br /><span>Start producing.</span></h2>
            <p>A home for your next great show.</p>
          </div>
          <div className="entry-art" aria-hidden="true">
            <div className="entry-art-glow" />
            <div className="entry-art-frame entry-art-frame-back" />
            <div className="entry-art-frame entry-art-frame-front">
              <div className="entry-art-guide" />
              <img src="/brand/producer-mark.png" width="176" height="176" alt="" />
            </div>
            <div className="entry-art-timeline"><span /><span /><span /><span /><span /></div>
          </div>
          <div className="entry-story-foot"><span>Build your Set.</span><span>Bring your people.</span></div>
        </aside>
        <div className="entry-panel">
          <ol className="entry-steps" aria-label="Setup progress">
            {stages.map((item, index) => (
              <li key={item.id} aria-current={item.id === stage ? 'step' : undefined} className={index < current ? 'is-complete' : ''}>
                <span aria-hidden="true">{index < current ? '✓' : index + 1}</span>{item.label}
              </li>
            ))}
          </ol>
          <div className="entry-content">{children}</div>
        </div>
      </div>
      <footer className="entry-footer">
        <span>Open-source. Built for creators.</span>
        <div><span>v{version}</span><button type="button" onClick={() => void openUrl('https://producer.dev').catch(() => {})}>producer.dev <span aria-hidden="true">↗</span></button></div>
      </footer>
    </section>
  );
}
