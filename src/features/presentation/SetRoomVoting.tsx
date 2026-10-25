import {useState} from 'react';
import type {Interaction} from '../../lib/ipc';
import {VotePanel,type VoteOpenInput} from '../../views/VotePanel';

/** Another view of the room's existing vote service, independent of show sequencing. */
export function SetRoomVoting({vote,savedVotes,onSelectVote,onOpen,onTransition}:{
 vote:Interaction|null;savedVotes:Interaction[];onSelectVote:(id:string)=>void;
 onOpen:(input:VoteOpenInput)=>Promise<boolean>;
 onTransition:(action:'open'|'reveal'|'close'|'cancel',holdMs?:number)=>void;
}) {
 const [editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <div className="set-room-vote" aria-busy={busy}>
  <VotePanel form={editing?'edit':vote&&['open','collecting','revealed'].includes(vote.state)?'live':'card'} vote={vote} savedVotes={savedVotes} onSelectVote={onSelectVote}
   editing={editing} onEdit={setEditing} onOpen={input=>{if(busy)return;setBusy(true);setError('');void onOpen(input).then(ok=>{if(ok)setEditing(false);}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}} onTransition={onTransition}/>
  {error&&<p role="alert">{error}</p>}
 </div>;
}
