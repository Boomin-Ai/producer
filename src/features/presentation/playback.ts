import {evaluate,type RehearsalState} from './rehearsal';
import type {PresentationPackage,PresentationNode} from './schema';
export type PlaybackConfig={start:'entry'|'manual';loop:boolean;exit:'reset'|'pause'|'continue';return:'restart'|'resume';hostControls:boolean};
export type MediaTransport={playing:boolean;positionMs:number;anchorMs:number;resumeAfterPause?:boolean};
export const playbackDefaults:PlaybackConfig={start:'entry',loop:true,exit:'reset',return:'restart',hostControls:false};
export function playable(mime:string){return mime.startsWith('video/')||mime==='application/lottie+json';}
export function layoutMedia(doc:PresentationPackage,layoutId:string,paired=false,state?:RehearsalState){
 const result=new Set<string>();const ids=[layoutId];if(paired){const other=layoutId.replace(/-(landscape|portrait)$/,(_,s)=>s==='landscape'?'-portrait':'-landscape');if(other!==layoutId)ids.push(other);}
 const visit=(n:PresentationNode,props:Record<string,import('./schema').Scalar>={})=>{if(state&&n.when!==undefined&&!evaluate(n.when,state,props,64,doc.set.tokens))return;if(n.type==='media'&&n.assetId)result.add(n.assetId);if(n.type==='component'){const def=doc.set.components[n.component!],resolved={...def.props};if(state)for(const[k,v]of Object.entries(n.props??{}))resolved[k]=evaluate(v,state,props,64,doc.set.tokens);visit(def.root,resolved);}n.children?.forEach(c=>visit(c,props));};
 for(const id of ids){const layout=doc.set.layouts.find(l=>l.id===id);if(layout)visit(layout.root);}return result;
}
export function mediaConfig(doc:PresentationPackage,id:string):PlaybackConfig{
 let legacy:PresentationNode|undefined;const visit=(n:PresentationNode)=>{if(n.assetId===id&&!legacy)legacy=n;n.children?.forEach(visit);};doc.set.layouts.forEach(l=>visit(l.root));
 return {...playbackDefaults,start:legacy?.autoplay===false?'manual':'entry',loop:legacy?.loop??true,...doc.set.assets?.[id]?.playback};
}
export function mediaPosition(t:MediaTransport,now=Date.now()){return t.positionMs+(t.playing?Math.max(0,now-t.anchorMs):0);}
export function enterMedia(doc:PresentationPackage,previous:string|undefined,next:string,media:Record<string,MediaTransport>,now=Date.now(),oldState?:RehearsalState,nextState?:RehearsalState){
 const old=previous?layoutMedia(doc,previous,true,oldState):new Set<string>();const current=layoutMedia(doc,next,true,nextState);
 for(const id of old)if(!current.has(id)&&media[id]){const c=mediaConfig(doc,id),t=media[id];if(c.exit!=='continue')media[id]={playing:false,positionMs:c.exit==='reset'?0:mediaPosition(t,now),anchorMs:now};}
 for(const id of current){if(!playable(doc.set.assets?.[id]?.mime??''))continue;const c=mediaConfig(doc,id),t=media[id];if(!old.has(id)){media[id]={playing:c.start==='entry'||!!(t?.playing&&c.exit==='continue'),positionMs:c.return==='restart'?0:t?mediaPosition(t,now):0,anchorMs:now};}}
}
