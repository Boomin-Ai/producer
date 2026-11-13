import {useId,useLayoutEffect,useRef,useState} from 'react';
import type {AssistantSuggestion} from './suggestions';

export function AssistantSuggestions({items,disabled,onChoose}:{items:AssistantSuggestion[];disabled:(item:AssistantSuggestion)=>boolean;onChoose:(item:AssistantSuggestion)=>void}) {
  const id=useId(),track=useRef<HTMLDivElement>(null);
  const [edges,setEdges]=useState({overflow:false,start:true,end:true});
  const signature=JSON.stringify(items.map(({id,label})=>[id,label]));
  const measure=()=>{
    const el=track.current;if(!el)return;
    const arrows=Array.from(el.parentElement?.querySelectorAll<HTMLElement>('.assistant-suggestions-arrow')??[]);
    // Test the space available without arrows, so resizing back to a wide dock
    // removes navigation as soon as every suggestion fits.
    const available=el.clientWidth+arrows.reduce((sum,arrow)=>sum+arrow.offsetWidth,0)+arrows.length*parseFloat(getComputedStyle(el.parentElement!).columnGap);
    const next={overflow:el.scrollWidth>available+1,start:el.scrollLeft<=1,end:el.scrollLeft+el.clientWidth>=el.scrollWidth-1};
    setEdges(old=>old.overflow===next.overflow&&old.start===next.start&&old.end===next.end?old:next);
  };
  useLayoutEffect(()=>{
    const el=track.current;if(!el)return;
    el.scrollLeft=0;measure();
    const observer=new ResizeObserver(measure);observer.observe(el);
    return()=>observer.disconnect();
  },[signature]);
  const reveal=(button:HTMLButtonElement)=>{
    const el=track.current;if(!el)return;
    const view=el.getBoundingClientRect(),box=button.getBoundingClientRect();
    if(box.left<view.left)el.scrollLeft-=view.left-box.left;
    else if(box.right>view.right)el.scrollLeft+=box.right-view.right;
  };
  const move=(direction:number)=>{
    const el=track.current;if(!el)return;
    el.scrollBy({left:direction*Math.max(80,el.clientWidth*.85),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  };
  const arrow=(direction:-1|1)=>edges.overflow&&<button className="assistant-suggestions-arrow" type="button" aria-label={direction<0?'Previous suggestions':'Next suggestions'} title={direction<0?'Previous suggestions':'Next suggestions'} aria-controls={id} disabled={direction<0?edges.start:edges.end} onClick={()=>move(direction)}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={direction<0?'m10 3-5 5 5 5':'m6 3 5 5-5 5'}/></svg></button>;
  if(!items.length)return null;
  return <div className="assistant-suggestions" role="group" aria-label="Suggested actions">
    {arrow(-1)}
    <div ref={track} id={id} className="assistant-suggestions-track" onScroll={measure}
      onFocusCapture={event=>{if(event.target instanceof HTMLButtonElement)reveal(event.target);}}
      onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!(event.target instanceof HTMLButtonElement))return;
        const buttons=Array.from(track.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index=buttons.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:index+(event.key==='ArrowRight'?1:-1);
        if(buttons[next]){event.preventDefault();buttons[next].focus({preventScroll:true});reveal(buttons[next]);}
      }}>
      {items.map(item=><button type="button" key={item.id} title={item.label} disabled={disabled(item)} onClick={()=>onChoose(item)}>{item.label}</button>)}
    </div>
    {arrow(1)}
  </div>;
}
