import { useEffect, useRef, useState } from "react";
import { type Notice as NoticeT, fade, subscribeNotices } from "../lib/notices";

/** The live list of notices; one subscriber per host. */
export function useNotices(): NoticeT[] {
  const [list, setList] = useState<NoticeT[]>([]);
  useEffect(() => subscribeNotices(setList), []);
  return list;
}

export function NoticeHost({ action }: { action?: { label: string; onClick: () => void; noticeKey: string } } = {}) {
  const list=useNotices(),[history,setHistory]=useState<NoticeT[]>([]),[open,setOpen]=useState(false);
  const panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(list.length)setHistory(old=>{const rows=new Map(old.map(n=>[n.id,n]));for(const n of list)rows.set(n.id,n);return [...rows.values()].slice(-20);});},[list]);
  useEffect(()=>{const timers=list.filter(n=>!n.faded&&!n.sticky&&n.tone!=='error').map(n=>setTimeout(()=>fade(n.id),n.ttl));return()=>timers.forEach(clearTimeout);},[list]);
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node))setOpen(false);};const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setOpen(false);};window.addEventListener('pointerdown',close);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',escape);};},[open]);
  const active=list.filter(n=>!n.faded),latest=history[history.length-1];
  const actionRows=history.filter(row=>row.key===action?.noticeKey),actionId=actionRows[actionRows.length-1]?.id;
  return <div className="rm-activity" ref={panel}>
    <button type="button" className="rm-activity-trigger" aria-label="Room activity" title={latest?.text??'Room activity'} aria-expanded={open} onClick={()=>setOpen(o=>!o)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 20h4"/></svg>{active.length>0&&<span className="rm-activity-count">{active.length}</span>}</button>
    {open&&<section className="rm-activity-panel" aria-label="Room activity ledger"><header><strong>Room activity</strong><button type="button" onClick={()=>setOpen(false)} aria-label="Close room activity">×</button></header><div className="rm-activity-list">{history.length?history.slice().reverse().map(n=><article key={n.id} className={'rm-activity-entry tone-'+n.tone}><span className="rm-activity-tone">{n.tone==='success'?'✓':n.tone==='error'?'!':'•'}</span><div><p>{n.text}</p>{action&&n.key===action.noticeKey&&n.id===actionId&&<button type="button" onClick={()=>{action.onClick();setOpen(false);}}>{action.label} ↗</button>}</div></article>):<p className="rm-activity-empty">Room updates will appear here.</p>}</div></section>}
  </div>;
}
