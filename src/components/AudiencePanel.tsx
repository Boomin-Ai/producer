import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './AudiencePanel.css';
export interface AudienceSnapshot { enabled?:boolean;direct_limit?:number;online?:number;host_online?:boolean;chat?:{id:string;name:string;from:string;text:string}[] }
export interface AudienceHand { id:string;name:string }
const SOCIAL_SITES = [
  {name:'Threads',url:'https://www.threads.com/'},
  {name:'LinkedIn',url:'https://www.linkedin.com/'},
  {name:'X',url:'https://x.com/'},
  {name:'Facebook',url:'https://www.facebook.com/'},
];
export function AudiencePanel({state,hands,host,send,share,invite,error,openSocial,canInvite=true,canShare=true,controls=true,compact=false,children}:{state:AudienceSnapshot;hands:AudienceHand[];host:boolean;hosted:boolean;send:(frame:Record<string,unknown>)=>boolean;share:()=>void;invite:(id:string)=>void;error:string|null;openSocial?:(url:string)=>void;canInvite?:boolean;canShare?:boolean;controls?:boolean;compact?:boolean;children?:ReactNode}) {
  const [text, setText] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const helpId = useId();
  const shareId = useId();
  const controlsId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const followChat = useRef(true);
  const chat = (state.chat ?? []).slice(-20);
  const latestMessage = chat[chat.length - 1]?.id;
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    setDismissedError(null);
    if (error !== 'slow_down') return;
    const timeout = setTimeout(() => setDismissedError(error), 3000);
    return () => clearTimeout(timeout);
  }, [error]);
  useEffect(() => {
    if (followChat.current && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [latestMessage]);
  const friendlyError = error === 'slow_down'
    ? 'Wait a moment, then try again.'
    : error === 'muted' ? 'Your chat is currently muted.'
    : error === 'invalid_message' ? 'Enter a message of up to 500 characters.'
    : error === 'forbidden' ? 'Your room permissions do not allow this action.'
    : error;
  const chatNotice = error === 'slow_down' || error === 'muted' || error === 'invalid_message';
  const notice = error && error !== dismissedError && <div className="aud-error" role="status"><span>{friendlyError}</span><button type="button" aria-label="Dismiss audience notice" onClick={() => setDismissedError(error)}>×</button></div>;

  if (!controls) return <>{children}</>;
  return <><section className="aud-panel" aria-label="Audience room">
    {compact && <button type="button" className="aud-config-toggle" popoverTarget={controlsId} aria-label="Open audience controls">Audience <span>{state.online ?? 0} connected{hands.length > 0 ? ` · ${hands.length} raised` : ''}</span> ▾</button>}
    <div className="aud-controls" id={controlsId} popover={compact ? 'auto' : undefined}>
    <header className="aud-header">
      {host ? <div className="aud-access-group" onKeyDown={e => { if (e.key === 'Escape') setHelpOpen(false); }}>
        <label className="aud-access" title={state.enabled ? 'Close audience access' : 'Open audience access'}><input type="checkbox" aria-label="Audience access" checked={!!state.enabled} onChange={e => send({type:'audience.configure',enabled:e.target.checked,direct_limit:state.direct_limit ?? 4})}/><strong>Audience</strong></label>
        <button type="button" className="aud-help" aria-label="What is audience access?" aria-expanded={helpOpen} aria-controls={helpId} title="What is audience access?" onClick={() => setHelpOpen(open => !open)}>?</button>
      </div> : <strong>Audience</strong>}
      <span className="aud-count">{state.online ?? 0} connected</span>
    </header>
    {canShare && <div className="aud-share-actions">
      <button type="button" onClick={share}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="7" y="7" width="10" height="11" rx="2"/><path d="M12 7V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>Copy link</button>
      <button type="button" aria-label="Share audience link on social" aria-expanded={shareOpen} aria-controls={shareId} onClick={() => setShareOpen(open => !open)}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M10 13V2m-4 4 4-4 4 4M5 9H3v8h14V9h-2"/></svg>Share <span className="aud-share-chevron" aria-hidden="true">{shareOpen ? '▴' : '▾'}</span></button>
    </div>}
    {canShare && shareOpen && <div className="aud-share-menu" id={shareId} onKeyDown={event => { if (event.key === 'Escape') setShareOpen(false); }}>
      <p>X opens a draft with your show link. For other sites, copy the link first.</p>
      <nav className="aud-social-links" aria-label="Open a social site">{SOCIAL_SITES.map(site => <a key={site.name} href={site.url} target="_blank" rel="noopener noreferrer" onClick={event => { if (openSocial) { event.preventDefault(); openSocial(site.url); } }}>{site.name} <span aria-hidden="true">↗</span></a>)}</nav>
    </div>}
    {host && helpOpen && <div className="aud-help-text" id={helpId}>
      <p>Share your audience link on social so people can join this show. Use Copy link, then Share to open a social site and paste it into your post, story, or message.</p>
      <p>People with the link can watch, chat, vote, react, and ask to join the stage. You choose who to invite onstage.</p>
    </div>}
    {host && <details className="aud-settings">
      <summary>Video settings <span>Up to {state.direct_limit ?? 4} viewers</span></summary>
      <div className="aud-settings-body">
        <label>Viewers with video <select value={state.direct_limit ?? 4} onChange={e => send({type:'audience.configure',enabled:!!state.enabled,direct_limit:Number(e.target.value)})}>{[1,2,4,6,8].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <p>How many people can watch video at once. Video comes from this computer; a higher limit needs more upload speed and processing power.</p>
        <p>This limit applies only to video. Chat and polls have a separate 100-person limit.</p>
      </div>
    </details>}
    {!chatNotice && notice}
    <section className="aud-hands" aria-label="Raised hands">
      <div className="aud-section-head"><strong>Raised hands</strong><span>{hands.length}</span></div>
      {hands.length === 0 ? <p className="aud-empty">No one waiting to join the stage.</p> : hands.map(h => <div key={h.id} className="aud-hand">
        <span className="aud-hand-name">{h.name}</span>
        <button type="button" className="aud-invite" disabled={!canInvite} onClick={() => invite(h.id)}>Invite</button>
        <details className="aud-actions"><summary aria-label={`More actions for ${h.name}`}>More</summary><div>
          <button type="button" onClick={() => send({type:'audience.moderate',id:h.id,action:'mute'})}>Mute chat</button>
          <button type="button" onClick={() => send({type:'audience.moderate',id:h.id,action:'remove'})}>Remove viewer</button>
        </div></details>
      </div>)}
    </section>
    </div>
    {children}
  </section>
    <div className={`aud-chat${compact ? ' aud-chat-compact' : ''}`} role="region" aria-label="Audience chat">
      <div className="aud-section-head"><strong>Chat</strong></div>
      <div className="aud-messages" ref={chatRef} tabIndex={0} aria-label="Chat messages" onScroll={() => { const el = chatRef.current; if (el) followChat.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {chat.length === 0 ? <p className="aud-empty">Messages from your audience will appear here.</p> : chat.map(m => <article className="aud-message" key={m.id}>
          <div className="aud-message-heading"><strong>{m.name}</strong><details className="aud-actions"><summary aria-label={`Actions for message from ${m.name}`}>More</summary><div>
            <button type="button" onClick={() => send({type:'audience.moderate',id:m.from,action:'delete',message_id:m.id})}>Delete message</button>
            {m.name !== 'Host' && m.from !== 'moderator' && <>
              <button type="button" onClick={() => send({type:'audience.moderate',id:m.from,action:'mute'})}>Mute chat</button>
              <button type="button" onClick={() => send({type:'audience.moderate',id:m.from,action:'remove'})}>Remove viewer</button>
            </>}
          </div></details></div><p>{m.text}</p>
        </article>)}
      </div>
      {chatNotice && notice}
      <form className="aud-composer" onSubmit={e => {
        e.preventDefault(); if (!text.trim() || cooldown) return;
        setDismissedError(error);
        if (send({type:'audience.chat',text:text.trim()})) {
          setText(''); setCooldown(true);
          timer.current = setTimeout(() => { setCooldown(false); timer.current = null; }, 2000);
        }
      }}>
        <input aria-label="Message the audience" maxLength={500} value={text} onChange={e => setText(e.target.value)} placeholder="Message the audience"/>
        <button type="submit" disabled={!text.trim() || cooldown}>{cooldown ? 'Wait…' : 'Send'}</button>
      </form>
    </div>
  </>;
}
