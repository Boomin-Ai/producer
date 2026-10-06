import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { AudienceChatMessage } from './AudiencePanel';
import { AudienceDestinationMark } from './AudienceDestination';
import './RoomChatPanel.css';

export interface ExternalChatLine {
  id?: string;
  platform: string;
  user: string;
  text: string;
  color?: string | null;
  emotes?: Record<string, string>;
  at?: number;
}
const CHANNELS = ['boomin', 'twitch', 'kick', 'youtube'] as const;
const LABELS = { boomin: 'Boomin', twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
const ROOM_CHAT_ERRORS = ['slow_down', 'muted', 'invalid_message', 'moderation_limit'];
const ERROR_TEXT: Record<string, string> = {
  slow_down: 'Wait a moment, then try again.', muted: 'Your room chat is currently muted.',
  invalid_message: 'Enter a message of up to 500 characters.', moderation_limit: 'The room moderation limit has been reached.',
};

/** Room messages share the platform reader, but only Boomin accepts replies
 * through the room control socket. External channels keep their read-only flow. */
export function RoomChatPanel({ messages, roomMessages, available, canControl, live, mini = false, error, send, logos, tints, renderText, pinnedRef, channels, onChannelsChange }: {
  channels: Record<string, boolean>;
  onChannelsChange: (channels: Record<string, boolean>) => void;
  messages: ExternalChatLine[];
  roomMessages: AudienceChatMessage[];
  available: boolean;
  canControl: boolean;
  live: boolean;
  mini?: boolean;
  error: string | null;
  send: (frame: Record<string, unknown>) => boolean;
  logos: Record<string, ReactNode>;
  tints: Record<string, string>;
  renderText: (message: ExternalChatLine) => ReactNode;
  pinnedRef: RefObject<boolean>;
}) {
  const [chipsOpen, setChipsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [behind, setBehind] = useState(0);
  const [pinned, setPinned] = useState(pinnedRef.current);
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousKeys = useRef(new Set<string>());
  const composeId = useId();
  const enabled = CHANNELS.filter(channel => channel !== 'boomin' || available);
  const active = enabled.filter(channel => channels[channel]);
  const rows = useMemo(() => [
    ...messages.map((message, index) => ({ ...message, key: message.id ?? `external-${index}-${message.at ?? ''}-${message.platform}-${message.user}-${message.text}`, room: undefined as AudienceChatMessage | undefined })),
    ...(available ? roomMessages.map(message => ({ platform: 'boomin', user: message.name, text: message.text, at: message.at, color: undefined, emotes: undefined, key: `room-${message.id}`, room: message })) : []),
  ].filter(message => channels[message.platform] !== false).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), [messages, roomMessages, channels, available]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => { setDismissedError(null); }, [error]);
  useEffect(() => {
    const added = rows.filter(row => !previousKeys.current.has(row.key)).length;
    previousKeys.current = new Set(rows.map(row => row.key));
    if (pinnedRef.current) {
      if (list.current) list.current.scrollTop = list.current.scrollHeight;
      setBehind(0);
    } else if (added) setBehind(count => count + added);
  }, [rows, mini, pinnedRef]);
  const follow = () => {
    pinnedRef.current = true; setPinned(true); setBehind(0);
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  };
  const toggle = (channel: string) => { follow(); onChannelsChange({ ...channels, [channel]: !channels[channel] }); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canControl || !available || !channels.boomin || cooldown || !draft.trim()) return;
    setLocalError(null); setDismissedError(error);
    if (!send({ type: 'audience.chat', text: draft.trim() })) { setLocalError('Reconnect to the room first.'); return; }
    setDraft(''); setCooldown(true);
    timer.current = setTimeout(() => { setCooldown(false); timer.current = null; }, 2000);
  };
  const moderate = (message: AudienceChatMessage, action: string) => {
    if (!canControl) return;
    setLocalError(null); setDismissedError(error);
    if (!send({ type: 'audience.moderate', id: message.from, action, ...(action === 'delete' ? { message_id: message.id } : {}) })) setLocalError('Reconnect to the room first.');
  };
  const notice = localError ?? (error !== dismissedError && error && ROOM_CHAT_ERRORS.includes(error) ? ERROR_TEXT[error] : null);
  const composer = <>
    {notice && <div className="room-chat-notice" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss chat notice" onClick={() => { setLocalError(null); setDismissedError(error); }}>×</button></div>}
    {available && channels.boomin && canControl && <form className="room-chat-composer" onSubmit={submit}>
      <input aria-label="Message Boomin room" maxLength={500} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Message Boomin room" />
      <button type="submit" disabled={!draft.trim() || cooldown}>{cooldown ? 'Wait…' : 'Send'}</button>
    </form>}
  </>;
  const empty = active.length === 0 ? 'Choose a chat channel above.' : available && channels.boomin ? 'Boomin room messages will appear here.' : live ? 'Connected — waiting for the first message.' : 'Connect a platform channel to read chat here.';
  const mark = (channel: string) => channel === 'boomin' ? <AudienceDestinationMark /> : logos[channel];
  return <div className={`room-chat${mini ? ' room-chat-mini' : ''}`}>
    {mini && !chipsOpen ? <div className="rm-chat-chips mini">
      <button type="button" className="rm-chat-chip on" title="Chat channels" aria-label="Chat channels" onClick={() => setChipsOpen(true)}><span className="rm-chip-logo">{active.length ? mark(active[0]) : '…'}</span></button>
      {active.length > 1 && <button type="button" className="rm-chip-more" aria-label="Show all chat channels" onClick={() => setChipsOpen(true)}>+{active.length - 1}</button>}
    </div> : <div className="rm-chat-chips" role="group" aria-label="Chat channels" onMouseLeave={() => mini && setChipsOpen(false)}>
      {enabled.map(channel => <button type="button" key={channel} className={`rm-chat-chip${channels[channel] ? ' on' : ''}`} aria-label={LABELS[channel]} aria-pressed={channels[channel]} title={`${channels[channel] ? 'Hide' : 'Show'} ${LABELS[channel]}`} onClick={() => toggle(channel)}><span className="rm-chip-logo">{mark(channel)}</span><span className="rm-chip-name">{LABELS[channel]}</span></button>)}
    </div>}
    {mini ? <div className="rm-chat-mini">
      {rows.slice(-2).map((message, index) => <div key={message.key} className={`rm-chat-msg${index === rows.slice(-2).length - 1 ? '' : ' prev'}`}><span className="rm-chat-user">{message.user}</span>{message.room ? <span className="rm-chat-text">{message.text}</span> : renderText(message)}</div>)}
      {rows.length === 0 && <div className="rm-chat-mini-empty">{empty}</div>}
    </div> : <div className="rm-chat-list" ref={list} tabIndex={0} aria-label="Room and platform messages" onScroll={() => {
      const element = list.current; if (!element) return;
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      pinnedRef.current = atBottom; setPinned(atBottom); if (atBottom) setBehind(0);
    }} onWheel={event => { if (event.deltaY < 0) { pinnedRef.current = false; setPinned(false); } }}>
      {rows.map(message => <div key={message.key} className="rm-chat-msg room-chat-message" data-channel={message.platform}>
        <div className="room-chat-message-body"><span className="room-chat-platform" title={message.platform === 'boomin' ? 'Boomin' : message.platform} aria-label={message.platform === 'boomin' ? 'Boomin message' : `${message.platform} message`}>{mark(message.platform)}</span><span className="rm-chat-user" style={{ color: message.color || (message.platform === 'boomin' ? 'var(--mint)' : tints[message.platform]) }}>{message.user}</span>{message.room ? <span className="rm-chat-text">{message.text}</span> : renderText(message)}</div>
        {message.room && canControl && <details className="room-chat-actions"><summary aria-label={`Actions for message from ${message.user}`}>More</summary><div>
          <button type="button" onClick={event => { moderate(message.room!, 'delete'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Delete message</button>
          {message.room.name !== 'Host' && message.room.from !== 'moderator' && <>
            <button type="button" onClick={event => { moderate(message.room!, 'mute'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Mute chat</button>
            <button type="button" onClick={event => { moderate(message.room!, 'remove'); event.currentTarget.closest('details')?.removeAttribute('open'); }}>Remove viewer</button>
          </>}
        </div></details>}
      </div>)}
      {rows.length === 0 && <div className="rm-alerts-empty">{empty}</div>}
    </div>}
    {!mini && !pinned && <button type="button" className="rm-chat-jump" onClick={follow}>{behind ? `${behind} new message${behind === 1 ? '' : 's'}` : 'Jump to latest'}</button>}
    {mini && available && channels.boomin && canControl ? <>
      <button type="button" className="room-chat-write" popoverTarget={composeId} aria-label="Write to Boomin room">{notice ? 'Chat notice' : 'Write'}</button>
      <div id={composeId} popover="auto" className="room-chat-compose-pop">{composer}</div>
    </> : !mini && composer}
  </div>;
}
