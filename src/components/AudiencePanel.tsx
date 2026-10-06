import { useEffect, useId, useState } from 'react';
import './AudiencePanel.css';
export interface AudienceChatMessage { id:string;name:string;from:string;text:string;at?:number }
export interface AudienceSnapshot { enabled?:boolean;direct_limit?:number;online?:number;host_online?:boolean;chat?:AudienceChatMessage[] }
export interface AudienceHand { id:string;name:string }
const SOCIAL_SITES = [
  {name:'Threads',url:'https://www.threads.com/'},
  {name:'LinkedIn',url:'https://www.linkedin.com/'},
  {name:'X',url:'https://x.com/'},
  {name:'Facebook',url:'https://www.facebook.com/'},
];
export interface AudiencePanelProps {
  state: AudienceSnapshot; hands: AudienceHand[]; host: boolean; hosted: boolean;
  send: (frame: Record<string, unknown>) => boolean; share: () => void;
  invite: (id: string) => void; error: string | null; openSocial?: (url: string) => void;
  canInvite?: boolean; canModerate?: boolean; canShare?: boolean; controls?: boolean;
  compact?: boolean; showHands?: boolean;
}
export function AudienceHands({ hands, invite, send, canInvite, canModerate }: Pick<AudiencePanelProps, 'hands' | 'invite' | 'send'> & { canInvite: boolean; canModerate: boolean }) {
  return <section className="aud-hands" aria-label="Stage requests">
    <div className="aud-section-head"><strong>Stage requests</strong><span>{hands.length}</span></div>
    {hands.length === 0 ? <p className="aud-empty">No requests to join.</p> : hands.map(h => <div key={h.id} className="aud-hand">
      <span className="aud-hand-name">{h.name}</span>
      {canInvite && <button type="button" className="aud-invite" onClick={() => invite(h.id)}>Invite to backstage</button>}
      {canModerate && <details className="aud-actions"><summary aria-label={`More actions for ${h.name}`}>More</summary><div>
        <button type="button" onClick={() => send({type:'audience.moderate',id:h.id,action:'mute'})}>Mute chat</button>
        <button type="button" onClick={() => send({type:'audience.moderate',id:h.id,action:'remove'})}>Remove viewer</button>
      </div></details>}
    </div>)}
  </section>;
}
export function AudiencePanel({state,hands,host,send,share,invite,error,openSocial,canInvite=true,canModerate=true,canShare=true,controls=true,compact=false,showHands=true}:AudiencePanelProps) {
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const helpId = useId();
  const shareId = useId();
  const controlsId = useId();
  useEffect(() => { setDismissedError(null); }, [error]);
  const friendlyError = error === 'forbidden' ? 'Your room permissions do not allow this action.' : error;
  const chatNotice = ['slow_down', 'muted', 'invalid_message', 'moderation_limit'].includes(error ?? '');
  const notice = error && error !== dismissedError && <div className="aud-error" role="status"><span>{friendlyError}</span><button type="button" aria-label="Dismiss audience notice" onClick={() => setDismissedError(error)}>×</button></div>;

  return <><section className="aud-panel" aria-label="Audience link">
    {compact && <button type="button" className="aud-config-toggle" popoverTarget={controlsId} aria-label="Open audience controls">Audience <span>{state.online ?? 0} connected{hands.length > 0 ? ` · ${hands.length} raised` : ''}</span> ▾</button>}
    <div className="aud-controls" id={controlsId} popover={compact ? 'auto' : undefined}>
    <header className="aud-header">
      <div className="aud-access-group" onKeyDown={e => { if (e.key === 'Escape') setHelpOpen(false); }}>
        {host ? <label className="aud-access" title={state.enabled ? 'Close audience access' : 'Open audience access'}><input type="checkbox" aria-label="Audience access" checked={!!state.enabled} disabled={typeof state.enabled !== 'boolean'} onChange={e => send({type:'audience.configure',enabled:e.target.checked,direct_limit:state.direct_limit ?? 4})}/><strong>Audience</strong></label>
          : <><strong>Audience</strong><span className="aud-access-state">{state.enabled === undefined ? "Connecting…" : state.enabled ? "Open" : "Closed"}</span></>}
        <button type="button" className="aud-help" aria-label="What is audience access?" aria-expanded={helpOpen} aria-controls={helpId} title="What is audience access?" onClick={() => setHelpOpen(open => !open)}>?</button>
      </div>
      <span className="aud-count">{state.online ?? 0} connected</span>
    </header>
    <p className="aud-link-description">Watch the room, set or show. Chat &amp; interact.</p>
    {canShare && <div className="aud-share-actions">
      <button type="button" aria-label="Copy audience link" onClick={share}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="7" y="7" width="10" height="11" rx="2"/><path d="M12 7V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg><span>Copy link</span></button>
      <button type="button" className="aud-share-icon" title="Share audience link" aria-label="Share audience link on social" aria-expanded={shareOpen} aria-controls={shareId} onClick={() => setShareOpen(open => !open)}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 13V2m-4 4 4-4 4 4M5 9H3v8h14V9h-2"/></svg></button>
    </div>}
    {canShare && shareOpen && <div className="aud-share-menu" id={shareId} onKeyDown={event => { if (event.key === 'Escape') setShareOpen(false); }}>
      <p>X opens a draft with your show link. For other sites, copy the link first.</p>
      <nav className="aud-social-links" aria-label="Open a social site">{SOCIAL_SITES.map(site => <a key={site.name} href={site.url} target="_blank" rel="noopener noreferrer" onClick={event => { if (openSocial) { event.preventDefault(); openSocial(site.url); } }}>{site.name} <span aria-hidden="true">↗</span></a>)}</nav>
    </div>}
    {helpOpen && <div className="aud-help-text" id={helpId}>
      <p>Audience access lets people watch the current room output. An active set or show is included in that same feed; you do not need a separate viewing link.</p>
      <p>People with the link can watch, chat, vote, react, and ask to join the stage. Their camera and microphone stay off until they join as a guest. Inviting them brings them to backstage; you choose when to put their media on the output.</p>
    </div>}
    {host && <details className="aud-settings">
      <summary>Video delivery <span>{state.direct_limit ?? 4} video viewer{state.direct_limit === 1 ? '' : 's'}</span></summary>
      <div className="aud-settings-body">
        <label><span>Video viewer limit</span><select aria-label="Video viewer limit" disabled={typeof state.enabled !== 'boolean'} value={state.direct_limit ?? 4} onChange={e => send({type:'audience.configure',enabled:!!state.enabled,direct_limit:Number(e.target.value)})}>{[1,2,4,6,8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <p>Maximum audience members receiving video at once. This is separate from guests sending camera and microphone. A higher limit uses more of this computer’s upload speed and processing power.</p>
        <p>This limit applies only to video. Chat and polls have a separate 100-person limit.</p>
      </div>
    </details>}
    {!chatNotice && notice}
    {showHands && <AudienceHands hands={hands} invite={invite} send={send} canInvite={controls && canInvite} canModerate={controls && canModerate} />}
    </div>
  </section>
  </>;
}
