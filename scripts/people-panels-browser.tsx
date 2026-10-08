import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PeoplePanel } from '../src/components/PeoplePanel';
import { InteractionsPanel } from '../src/components/InteractionsPanel';
import { GuestPanel } from '../src/views/Live';
import { VotePanel, type VoteOpenInput } from '../src/views/VotePanel';
import { voteFormFor } from '../src/lib/votePanel';
import { sourceIdsFor } from '../src/lib/participants';
import type { RoomGuest, Interaction, LiveItem } from '../src/lib/ipc';
import '../src/App.css';
function Harness() {
  const params = new URLSearchParams(location.search);
  const dock = params.get('dock') ?? 'right';
  const compact = params.has('mini');
  const panelWidth = Number(params.get('width')) || 320;
  const admitOnly = params.has('admit-only');
  const [role, setRole] = useState(params.get('role') ?? 'host');
  const control = role !== 'viewer';
  const [state, setState] = useState({ enabled: true, direct_limit: 4, online: 3 });
  const [calls, setCalls] = useState<unknown[]>([]);
  const call = (value: unknown) => setCalls(previous => [...previous, value]);
  const [roster, setRoster] = useState<RoomGuest[]>([
    { id:'admitted-one', display_name:'Alex', state:'admitted', render_url:'https://example.test/g/one', kind:'member' },
    { id:'waiting-one', display_name:'Taylor', state:'waiting', render_url:null, kind:'visitor' },
  ]);
  const [stage, setStage] = useState<string[]>([]);
  const [items, setItems] = useState([{ id:sourceIdsFor('admitted-one').camera, kind:'guest', name:'Alex', visible:false, muted:false }] as LiveItem[]);
  const [editing, setEditing] = useState(false);
  const [vote, setVote] = useState<Interaction | null>(null);
  const send = (frame: Record<string, unknown>) => {
    call(frame);
    if (frame.type === 'audience.configure') setState(previous => ({...previous, enabled:!!frame.enabled, direct_limit:Number(frame.direct_limit)}));
    return true;
  };
  function open(input: VoteOpenInput) {
    call({type:'vote.open', ...input}); setEditing(false);
    setVote({id:'poll-one',type:'vote',state:'collecting',spec:{prompt:input.prompt,options:[{id:'a',label:input.a},{id:'b',label:input.b}],who:input.who}, timing:{},tally:{total:2,options:{a:2,b:0}}} as Interaction);
  }
  return <main className="room" style={{display:'block',height:'100vh',padding:8,overflow:'auto'}}>
    <section className="rm-panel rm-panel-guests" data-in={dock} style={{width: dock === 'right' ? `min(${panelWidth}px,100%)` : '100%', height: compact ? 70 : dock === 'bottom' ? 260 : 600}}><div className="rm-panel-body">
      <PeoplePanel compact={compact} guestCount={roster.filter(g=>g.render_url).length} waitingCount={roster.filter(g=>!g.render_url).length}
        onCopyGuestLink={role === 'host' ? ()=>call('copy-guest') : undefined}
        audience={{state,hands:[{id:'viewer-one',name:'Jordan'}],host:role==='host',hosted:true,controls:control,canInvite:control,canModerate:control&&!admitOnly,canShare:control,
          send,share:()=>call('copy-audience'),openSocial:site=>call(site),invite:id=>call({type:'invite',id}),error:null}}>
        <GuestPanel thumbs={{}} roster={roster} items={items} error={null} role={role as 'host'|'mod'|'viewer'} control={control} permissions={admitOnly ? {admit:true,remove:false,stage:false,order:false} : undefined} stage={stage} form={compact?'row':'column'}
          onAdmit={id=>{call({type:'admit',id});setRoster(previous=>previous.map(g=>g.id===id?{...g,state:'admitted',render_url:'https://example.test/g/two'}:g));}}
          onRemove={id=>{call({type:'remove',id});setRoster(previous=>previous.filter(g=>g.id!==id));}}
          onShow={(id,visible)=>{call({type:'show',id,visible});setItems(previous=>previous.map(i=>i.id===id?{...i,visible}:i));}}
          onMute={(id,muted)=>{call({type:'mute',id,muted});setItems(previous=>previous.map(i=>i.id===id?{...i,muted}:i));}}
          onStageToggle={id=>{call({type:'stage',id});setStage(previous=>previous.includes(id)?previous.filter(x=>x!==id):[...previous,id]);}}
          onOrder={(id,dir)=>call({type:'order',id,dir})}/>
      </PeoplePanel>
    </div></section>
    <section className="rm-panel rm-panel-vote" data-in="right" style={{width:'min(320px,100%)',height:280,marginTop:12}}><div className="rm-panel-body">
      {control ? <InteractionsPanel><VotePanel form={voteFormFor('right',{state:vote?.state??null,editing})} vote={vote} editing={editing} onEdit={setEditing} onOpen={open} onTransition={t=>{call({type:'vote.transition',transition:t});setVote(previous=>previous?{...previous,state:t==='close'?'closed':t==='reveal'?'revealed':previous.state}:null);}} /></InteractionsPanel> : <p>Read-only seat</p>}
    </div></section>
    <button onClick={()=>setRole('viewer')}>Make read-only</button><output id="calls">{JSON.stringify(calls)}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
