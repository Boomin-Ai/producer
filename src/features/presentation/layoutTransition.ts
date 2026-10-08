import {clockPosition,sampleTrack,type AnimationTrack} from './animation';
import type {OutputProjection,RenderNode} from './projection';
/** Layout states share authored IDs. Sample the current interrupted motion,
 * then emit bounded tracks consumed by both browser and native renderers. */
export function layoutTransition(from:OutputProjection,to:OutputProjection,durationMs:number,now:number):AnimationTrack[]{
 if(from.width!==to.width||from.height!==to.height)return [];
 const key=(n:RenderNode)=>n.id.split('/').slice(2).join('/');
 const old=new Map<string,RenderNode>();const visit=(n:RenderNode)=>{old.set(key(n),n);n.children.forEach(visit);};visit(from.root);
 const clock=from.timeline?clockPosition(from.timeline.clock,now):{positionMs:0,segmentMs:0};
 const current=(n:RenderNode,p:string,fallback:number)=>{const track=from.timeline?.tracks.find(t=>t.target===n.id&&t.property===p);return track?sampleTrack(track,track.clock==='show'?clock.positionMs:clock.segmentMs):fallback;};
 const tracks:AnimationTrack[]=[];const text:RenderNode[]=[];
 const walk=(n:RenderNode)=>{
  const prev=old.get(key(n));
  if(prev&&prev.type===n.type&&n.styles.position==='absolute'&&['slot','shader','box','media'].includes(n.type)){
   for(const [property,style]of [['x','left'],['y','top'],['width','width'],['height','height']] as const){const a=prev.styles[style],b=n.styles[style];if(typeof a!=='number'||typeof b!=='number')continue;const start=current(prev,property,a);if(start!==b)tracks.push({target:n.id,property,keyframes:[{atMs:0,value:start},{atMs:durationMs,value:b}],easing:'easeInOut',clock:'segment'});}
  }
  if(n.type==='text'&&(!prev||prev.text!==n.text||prev.styles.left!==n.styles.left||prev.styles.top!==n.styles.top||prev.styles.fontSize!==n.styles.fontSize))text.push(n);
  n.children.forEach(walk);
 };walk(to.root);
 // Morph tracks replace authored tracks with the same target/property in
 // outputProjection. Count the merged timeline rather than counting both.
 const authored=new Set((to.timeline?.tracks??[]).map(t=>`${t.target}:${t.property}`));
 const merged=new Set([...authored,...tracks.map(t=>`${t.target}:${t.property}`)]);
 if(merged.size>32)throw new Error('Layout transition exceeds 32 animation tracks.');
 for(const n of text){
  const key=`${n.id}:opacity`;
  if(!merged.has(key)&&merged.size===32)continue;
  tracks.push({target:n.id,property:'opacity',keyframes:[{atMs:0,value:0},{atMs:Math.round(durationMs*.35),value:0},{atMs:durationMs,value:1}],easing:'easeOut',clock:'segment'});
  merged.add(key);
 }
 return tracks;
}
