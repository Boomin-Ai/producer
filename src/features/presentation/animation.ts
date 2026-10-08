export type AnimationClock={running:boolean;positionMs:number;segmentMs:number;anchorMs:number};
export type AnimationTrack={target:string;property:'x'|'y'|'width'|'height'|'opacity'|'scale'|'rotation'|'shader.intensity'|'shader.scale';keyframes:Array<{atMs:number;value:number}>;easing?:'linear'|'easeIn'|'easeOut'|'easeInOut';clock?:'show'|'segment';delayMs?:number;loop?:'none'|'repeat'|'pingpong'};
export type LayoutAnimation={tracks:AnimationTrack[];transition?:{type:'cut'|'crossfade'|'morph';durationMs:number}};
export type AnimationTimeline=LayoutAnimation&{clock:AnimationClock};
export function clockPosition(clock:AnimationClock,now=Date.now()){
 const delta=clock.running?Math.max(0,now-clock.anchorMs):0;
 return {positionMs:clock.positionMs+delta,segmentMs:clock.segmentMs+delta};
}
export function sampleTrack(track:AnimationTrack,position:number){
 const frames=track.keyframes,duration=frames[frames.length-1].atMs;
 let time=Math.max(0,position-(track.delayMs??0));
 if(track.loop==='repeat')time%=duration;
 else if(track.loop==='pingpong'){time%=duration*2;if(time>duration)time=duration*2-time;}
 if(time>=duration)return frames[frames.length-1].value;
 const index=frames.findIndex((frame,i)=>i>0&&frame.atMs>=time),a=frames[Math.max(0,index-1)],b=frames[index];
 let t=(time-a.atMs)/(b.atMs-a.atMs);
 if(track.easing==='easeIn')t*=t;else if(track.easing==='easeOut')t=1-(1-t)*(1-t);else if(!track.easing||track.easing==='easeInOut')t=t*t*(3-2*t);
 return a.value+(b.value-a.value)*t;
}
