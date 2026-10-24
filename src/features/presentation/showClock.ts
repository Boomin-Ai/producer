import {useEffect} from 'react';
import type {RehearsalSession} from './rehearsal';
/** One clock owner per session. Mounting an editor or panel cannot double-tick a show. */
const clocks=new WeakMap<RehearsalSession,{refs:number;timer:ReturnType<typeof setInterval>}>();
export function useShowClock(session:RehearsalSession){
 useEffect(()=>{
  let clock=clocks.get(session);
  if(!clock){let last=performance.now();const timer=setInterval(()=>{const now=performance.now(),elapsed=now-last;last=now;const state=session.snapshot();if(state.running&&!state.paused)session.send({type:'tick',milliseconds:Math.min(3_600_000,elapsed)});},100);clock={refs:0,timer};clocks.set(session,clock);}
  clock.refs++;
  return()=>{if(--clock.refs===0){clearInterval(clock.timer);clocks.delete(session);}};
 },[session]);
}
