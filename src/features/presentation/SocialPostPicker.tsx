import {useEffect,useRef,useState} from 'react';
import {dataIntegrations,type SavedConnection} from '../../lib/dataIntegrations';
import type {ModuleBindings} from './moduleConnections';
type Post={id:string;text:string;postedAt:string|null;type:string};
export function SocialPostPicker({endpoint,connection,binding,onChange,disabled}:{endpoint:string;connection:SavedConnection;binding:ModuleBindings[string];onChange:(binding:ModuleBindings[string])=>void;disabled:boolean}){
 const [posts,setPosts]=useState<Post[]>([]),[after,setAfter]=useState<string|null>(null),[search,setSearch]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const identity=endpoint+':'+connection.connection.id+':'+connection.revision,ticket=useRef(0),request=useRef(false);
 useEffect(()=>{const generation=++ticket.current;request.current=true;setPosts([]);setAfter(null);setError('');setBusy(true);
  void dataIntegrations.socialPosts(endpoint,connection).then(result=>{if(generation===ticket.current){setPosts(result.posts);setAfter(result.after);}}).catch(e=>{if(generation===ticket.current)setError(e instanceof Error?e.message:'Could not load posts');}).finally(()=>{if(generation===ticket.current){setBusy(false);request.current=false;}});
  return()=>{ticket.current++;request.current=false;};
 },[identity,reload]);
 const more=async()=>{if(request.current||!after)return;const generation=ticket.current;request.current=true;setBusy(true);setError('');try{const result=await dataIntegrations.socialPosts(endpoint,connection,after);if(generation===ticket.current){setPosts(old=>[...old,...result.posts.filter(p=>!old.some(v=>v.id===p.id))]);setAfter(result.after);}}catch(e){if(generation===ticket.current)setError(String(e));}finally{if(generation===ticket.current){request.current=false;setBusy(false);}}};
 const selected=binding.selection?.postId,filtered=posts.filter(p=>p.id===selected||p.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 return <div className="set-social-selection">
  <label>Metrics period<select aria-label="Threads metrics period" disabled={disabled} value={binding.selection?.rangeDays??7} onChange={e=>onChange({...binding,selection:{...binding.selection,rangeDays:Number(e.target.value) as 7|30}})}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></label>
  <label>Find a post<input type="search" aria-label="Find Threads post" value={search} disabled={disabled} onChange={e=>setSearch(e.target.value)} placeholder="Search loaded posts…"/></label>
  <label>Spotlight post<select aria-label="Threads spotlight post" disabled={disabled||busy&&!posts.length} value={selected??''} onChange={e=>onChange({...binding,selection:{rangeDays:binding.selection?.rangeDays??7,...(e.target.value?{postId:e.target.value}:{})}})}>
   <option value="">Choose a published post</option>{selected&&!posts.some(p=>p.id===selected)&&<option value={selected}>Saved spotlight post</option>}{filtered.map(p=><option key={p.id} value={p.id}>{p.text.slice(0,100)||p.type+' post'}{p.postedAt?' · '+new Date(p.postedAt).toLocaleDateString():''}</option>)}
  </select></label>
  {busy&&<p role="status">Loading posts…</p>}{error&&<p role="alert">{error}</p>}
  <div className="set-social-actions">{after&&<button type="button" disabled={disabled||busy} onClick={()=>void more()}>Load more posts</button>}<button type="button" disabled={disabled||busy} onClick={()=>setReload(v=>v+1)}>Refresh posts</button></div>
  <p className="set-section-note">The selected post drives the spotlight and replies views. Apply your changes to update the room. Your account and post selection stay in this workspace.</p>
 </div>;
}
