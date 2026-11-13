import {useRef,useState} from 'react';
import type {AssistantAttachment,AttachmentPurpose} from './attachments';
export function AssistantAttachButton({disabled,onAdd}:{disabled:boolean;onAdd(files:File[],purpose:AttachmentPurpose):Promise<void>}) {
  const file=useRef<HTMLInputElement>(null),purpose=useRef<AttachmentPurpose>('reference');
  const [open,setOpen]=useState(false);
  return <><button type="button" className="assistant-attach" aria-label="Attach files" title="Add inspiration or production assets" disabled={disabled} aria-expanded={open} onClick={()=>setOpen(!open)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7L14 1"/></svg></button>
    {open&&<div className="assistant-attach-menu" role="group" aria-label="Attachment purpose">{(['reference','production'] as const).map(value=><button type="button" key={value} onClick={()=>{purpose.current=value;setOpen(false);file.current?.click();}}>{value==='reference'?'Add inspiration':'Add production asset'}<small>{value==='reference'?'Look and feel only':'Available to place in your Set'}</small></button>)}</div>}
    <input ref={file} hidden type="file" multiple aria-label="Assistant attachments" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.json,.txt,.md" onChange={event=>{const files=Array.from(event.target.files??[]);event.target.value='';void onAdd(files,purpose.current);}}/>
  </>;
}
export function AssistantAttachmentList({items,onRemove,disabled}:{items:AssistantAttachment[];onRemove(id:string):void;disabled:boolean}) {
  return items.length?<div className="assistant-attachments" aria-label="Attachments">{items.map(item=><div key={item.id}>{item.image&&<img src={item.image} alt=""/>}<span title={item.name}>{item.name}<small>{item.purpose==='reference'?'Inspiration only':'Production asset'}</small></span><button type="button" aria-label={`Remove attachment ${item.name}`} disabled={disabled} onClick={()=>onRemove(item.id)}>×</button></div>)}</div>:null;
}
