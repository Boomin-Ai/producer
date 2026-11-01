import {parsePackage,type PresentationPackage,type PresentationNode} from '../schema';
import {packageRevision} from './compiler';

export interface RingRepair {layout:string;ring:string;camera:string}
export interface VisualIssue {
 code:string;layout:string;node:string;relatedNode?:string;path?:string;
 measurements?:Record<string,number>;
 severity:'error'|'warning';message:string;repair?:RingRepair;
}
export interface VisualReport {issues:VisualIssue[];textChecked:boolean;scope:'configured-layouts';nativeReadiness:'not-tested'}
type Rect={x:number;y:number;width:number;height:number};
function bounds(node:PresentationNode):Rect|undefined {
 const s=node.styles??{},v=[s.left,s.top,s.width,s.height];
 if(s.position!=='absolute'||s.transform!==undefined)return;
 if(v.some(n=>typeof n!=='number'||!Number.isFinite(n)))return;
 return {x:v[0] as number,y:v[1] as number,width:v[2] as number,height:v[3] as number};
}
const cx=(r:Rect)=>r.x+r.width/2,cy=(r:Rect)=>r.y+r.height/2;
const circular=(node:PresentationNode,r:Rect)=>Math.abs(r.width-r.height)<=1&&(node.appearance?.shape==='circle'||typeof node.appearance?.cornerRadius==='number'&&node.appearance.cornerRadius>=r.width/2);

/** Intent-sensitive advisory checks. Containment and text over media are allowed.
 * Ring association is inferred only when there is one overlapping circular slot. */
export function checkVisualGeometry(doc:PresentationPackage):VisualReport {
 const issues:VisualIssue[]=[];
 for(const layout of doc.set.layouts){
  const nodes=layout.root.children??[];
  for(const ring of nodes.filter(n=>n.shader?.effect==='voiceRing')){
   const r=bounds(ring);if(!r)continue;
   const cameras=nodes.filter(n=>{const b=bounds(n);return n.type==='slot'&&b&&circular(n,b)&&Math.abs(cx(b)-cx(r))<(b.width+r.width)/2&&Math.abs(cy(b)-cy(r))<(b.height+r.height)/2;});
   if(cameras.length!==1){issues.push({code:'ring_association',layout:layout.id,node:ring.id,severity:'warning',message:'Select the camera this ring should surround; no unique circular camera was found.'});continue;}
   const camera=cameras[0],c=bounds(camera)!,radius=ring.shader!.radius;
   const issue=(code:string,message:string)=>issues.push({code,layout:layout.id,node:ring.id,relatedNode:camera.id,severity:'error',message,repair:{layout:layout.id,ring:ring.id,camera:camera.id}});
   if(Math.abs(cx(r)-cx(c))>1||Math.abs(cy(r)-cy(c))>1)issue('ring_center','Center the ring on its camera.');
   if(Math.abs(radius-c.width/2)>1)issue('ring_radius',`Use radius ${c.width/2}px to meet the camera edge; current radius is ${radius}px.`);
   if(Math.abs(r.width-r.height)>1)issue('ring_square','Use square ring bounds so its contour stays circular.');
   if(Math.min(r.width,r.height)/2-radius<90)issue('ring_padding','Reserve at least 90px outside the ring radius for voice peaks; the current bounds can suppress or clip motion.');
  }
  // Text/text collisions are suspicious, but do not reject editorial layering.
  const texts=nodes.filter(n=>n.type==='text');
  for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
   const a=bounds(texts[i]),b=bounds(texts[j]);if(!a||!b)continue;
   const area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
   if(area>Math.min(a.width*a.height,b.width*b.height)*.1)issues.push({code:'text_overlap',layout:layout.id,node:texts[i].id,relatedNode:texts[j].id,severity:'warning',message:'Text boxes overlap. Confirm this is intentional editorial layering.'});
  }
 }
 return {issues,textChecked:false,scope:'configured-layouts',nativeReadiness:'not-tested'};
}

/** One deterministic repair, explicitly targeted and revision-fenced. No model call. */
export async function repairCameraRing(doc:PresentationPackage,input:RingRepair&{baseRevision:string}):Promise<PresentationPackage>{
 if(await packageRevision(doc)!==input.baseRevision)throw Error('The Set changed. Recheck the current draft before repairing it.');
 const next=structuredClone(doc),layout=next.set.layouts.find(l=>l.id===input.layout);
 const ring=layout?.root.children?.find(n=>n.id===input.ring),camera=layout?.root.children?.find(n=>n.id===input.camera);
 if(!layout||ring?.shader?.effect!=='voiceRing'||camera?.type!=='slot')throw Error('Choose a direct voiceRing and camera in the same layout.');
 const c=bounds(camera);if(!c||!bounds(ring)||!circular(camera,c))throw Error('Ring repair requires absolute numeric bounds and an untransformed square circular camera.');
 const radius=c.width/2,size=c.width+180,x=c.x-90,y=c.y-90;
 if(x<0||y<0||x+size>layout.width||y+size>layout.height)throw Error('There is not enough canvas space around this camera. Move or resize it before repairing the ring.');
 ring.styles={...ring.styles,left:x,top:y,width:size,height:size};ring.shader.radius=radius;
 return parsePackage(next);
}
