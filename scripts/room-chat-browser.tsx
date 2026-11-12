import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type AudienceChatMessage } from '../src/components/AudiencePanel';
import { PeoplePanel } from '../src/components/PeoplePanel';
import { RoomChatPanel, type ExternalChatLine } from '../src/components/RoomChatPanel';
import '../src/App.css';
const initial = [{ id: 'host', from: 'host', name: 'Host', text: 'Welcome', at: 1 }, { id: 'viewer', from: 'viewer-id', name: 'Jordan', text: 'Room hello', at: 3 }];
function Harness() {
  const [messages, setMessages] = useState<AudienceChatMessage[]>(initial);
  const [external, setExternal] = useState<ExternalChatLine[]>([{ id: 'twitch-1', platform: 'twitch', user: 'Taylor', text: 'Twitch hello', at: 2 }]);
  const [frames, setFrames] = useState<Record<string, unknown>[]>([]);
  const [controls, setControls] = useState(true);
  const [online, setOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emoteLoaded, setEmoteLoaded] = useState(false);
  const pinned = useRef(true);
  const [channels, setChannels] = useState<Record<string, boolean>>({ boomin: true, twitch: true, kick: true, youtube: true });
  const mini = new URLSearchParams(location.search).has('mini');
  const send = (frame: Record<string, unknown>) => {
    if (!online) return false;
    setFrames(previous => [...previous, frame]);
    if (frame.type === 'audience.chat') setMessages(previous => [...previous, { id: crypto.randomUUID(), from: 'host', name: 'Host', text: String(frame.text), at: Date.now() }]);
    if (frame.action === 'delete') setMessages(previous => previous.filter(message => message.id !== frame.message_id));
    return true;
  };
  return <main className="room" style={{ display: 'block', height: '100vh', padding: 8 }}>
    <section className="rm-panel rm-panel-chat" data-in={mini ? 'top' : 'right'} style={{ width: mini ? 650 : 300, height: mini ? 65 : 320 }}><div className="rm-panel-body">
      <RoomChatPanel channels={channels} onChannelsChange={setChannels} messages={external} roomMessages={messages} available canControl={controls} live mini={mini} error={error} send={send} logos={{ twitch: 'T', kick: 'K', youtube: 'Y' }} tints={{}} renderText={m => <span className="rm-chat-text">{m.text}{m.id === 'late-emote' && emoteLoaded && <img alt="Delayed emote" style={{width:120,height:100,display:'block'}} src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='100'%3E%3Crect width='120' height='100' fill='seagreen'/%3E%3C/svg%3E" />}</span>} pinnedRef={pinned} />
    </div></section>
    <section className="rm-panel rm-panel-guests" data-in="bottom" style={{ width: 650, height: 220 }}><div className="rm-panel-body"><PeoplePanel guestCount={0} waitingCount={0} onCopyGuestLink={() => {}} audience={{state:{enabled:true,online:1,chat:messages},hands:[],host:true,controls,hosted:true,send,share:()=>{},invite:()=>{},error}}><p>No guests yet.</p></PeoplePanel></div></section>
    <button onClick={() => setControls(value => !value)}>Toggle control grant</button>
    <button onClick={() => setOnline(value => !value)}>Toggle connection</button>
    <button onClick={() => setError('slow_down')}>Server cooldown</button>
    <button onClick={() => setMessages(previous => [...previous, { id: crypto.randomUUID(), from: 'viewer-id', name: 'Jordan', text: `Incoming ${previous.length}`, at: Date.now() }])}>Receive room message</button>
    <button onClick={() => setExternal(previous => [...previous, { id: crypto.randomUUID(), platform: 'twitch', user: 'Taylor', text: 'Next external', at: Date.now() }])}>Receive platform message</button>
    <button onClick={() => { setEmoteLoaded(false); setExternal(previous => [...previous.filter(message => message.id !== 'late-emote'), { id:'late-emote', platform:'twitch', user:'Taylor', text:'Delayed emote message', at:Date.now() }]); }}>Receive delayed emote</button>
    <button onClick={() => setEmoteLoaded(true)}>Load emote</button>
    <output id="frames">{JSON.stringify(frames)}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
