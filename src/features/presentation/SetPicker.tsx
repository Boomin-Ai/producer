import {useId,useRef,useState} from 'react';
type Choice={value:string;label:string;group:string};
export function SetPicker({value,options,onSelect}:{value:string;options:Choice[];onSelect:(value:string)=>void}) {
 const id=useId(),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null);
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0);
 const [position,setPosition]=useState({left:8,top:80,width:360,maxHeight:360});
 const filtered=options.filter(o=>o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const close=()=>{menu.current?.hidePopover();trigger.current?.focus();};
 const choose=(o:Choice)=>{close();onSelect(o.value);};
 const show=()=>{
  const r=trigger.current!.getBoundingClientRect(),width=Math.min(Math.max(r.width,320),innerWidth-16),below=innerHeight-r.bottom-14,above=r.top-14;
  const maxHeight=Math.min(420,Math.max(below,above));
  setPosition({left:Math.max(8,Math.min(r.left,innerWidth-width-8)),top:below>=Math.min(300,above)?r.bottom+6:Math.max(8,r.top-maxHeight-6),width,maxHeight});
  setQuery('');setActive(Math.max(0,options.findIndex(o=>o.value===value)));menu.current?.showPopover();
 };
 return <div className="set-picker">
  <button ref={trigger} type="button" role="combobox" aria-label="Choose set" aria-haspopup="listbox" aria-controls={`${id}-list`} aria-expanded={open} onClick={()=>open?close():show()} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();show();}}}>
   <span>{options.find(o=>o.value===value)?.label??'Choose a set…'}</span><span aria-hidden="true">⌄</span>
  </button>
  <div ref={menu} popover="auto" className="set-picker-menu" style={position} onToggle={e=>{setOpen(e.newState==='open');if(e.newState==='open')search.current?.focus();}}
   onKeyDown={e=>{
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}
    else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const next=filtered.length?(active+(e.key==='ArrowDown'?1:-1)+filtered.length)%filtered.length:0;setActive(next);document.getElementById(`${id}-${next}`)?.scrollIntoView({block:'nearest'});}
    else if(e.key==='Enter'){e.preventDefault();if(filtered[active])choose(filtered[active]);}
   }}>
   <input ref={search} type="search" aria-label="Search sets" aria-controls={`${id}-list`} aria-activedescendant={filtered[active]?`${id}-${active}`:undefined} placeholder="Search sets…" value={query} onChange={e=>{setQuery(e.target.value);setActive(0);}}/>
   <div id={`${id}-list`} role="listbox" aria-label="Sets" className="set-picker-list">{filtered.map((o,i)=><div key={o.value}>
    {(i===0||filtered[i-1].group!==o.group)&&<div className="set-picker-group">{o.group}</div>}
    <button type="button" role="option" id={`${id}-${i}`} aria-selected={o.value===value} tabIndex={-1} data-active={i===active} onMouseMove={()=>setActive(i)} onClick={()=>choose(o)}><span>{o.label}</span><span aria-hidden="true">{o.value===value?'✓':''}</span></button>
   </div>)}{!filtered.length&&<p className="set-picker-empty">No sets found.</p>}</div>
  </div>
 </div>;
}
