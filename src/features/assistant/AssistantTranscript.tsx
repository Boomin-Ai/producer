import {useCallback,useLayoutEffect,useRef,type ReactNode} from 'react';

/** Each opened view starts at the latest message before paint. While it stays
 * open, new content follows the tail only if the reader has not scrolled up. */
export function AssistantTranscript({hidden=false,children}:{hidden?:boolean;children:ReactNode}) {
  const viewport=useRef<HTMLDivElement>(null),following=useRef(true),hadViewport=useRef(false);
  const align=useCallback(()=>{
    const element=viewport.current;
    if(hidden||!element?.isConnected||!element.clientHeight||!element.clientWidth){hadViewport.current=false;return;}
    if(!hadViewport.current||following.current){element.scrollTop=element.scrollHeight;following.current=true;}
    hadViewport.current=true;
  },[hidden]);
  useLayoutEffect(()=>{
    following.current=true;hadViewport.current=false;
    const element=viewport.current!;
    // A dialog/closed dock can have no layout at mount. ResizeObserver runs
    // before paint when that viewport appears, including WebKit popovers.
    const resize=new ResizeObserver(align);resize.observe(element);
    for(const child of element.children)resize.observe(child);
    const content=new MutationObserver(records=>{
      for(const record of records){
        for(const node of record.removedNodes)if(node instanceof Element)resize.unobserve(node);
        for(const node of record.addedNodes)if(node instanceof Element)resize.observe(node);
      }
      align();
    });
    content.observe(element,{childList:true});
    align();return()=>{resize.disconnect();content.disconnect();};
  },[align]);
  useLayoutEffect(align);
  return <div ref={viewport} hidden={hidden} className="assistant-messages" role="log" aria-label="Assistant messages" aria-live="polite"
    onScroll={event=>{const element=event.currentTarget;following.current=element.scrollHeight-element.clientHeight-element.scrollTop<=24;}}>{children}</div>;
}
