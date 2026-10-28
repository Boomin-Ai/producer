import {chartData,resolveChart,type ChartSpec} from './charts';
import {validateMask,validateBackdrop,type LayerMask,type BackdropEffect} from './visualEffects';
import {mediaConfig} from './playback';
import { parseSourceAppearance, type SourceAppearance } from '../../lib/sourceAppearance';
import { evaluate, type RehearsalState } from './rehearsal';
import { safeStyle, type PresentationPackage, type PresentationNode, type Scalar } from './schema';
import { motionCss } from './nordcraft-adapter/motion';
import {type AnimationTimeline} from './animation';

export interface RenderNode {
  chart?:ChartSpec;
  mask?:LayerMask;backdrop?:BackdropEffect;
  playback?:import('./playback').MediaTransport;
  assetId?:string;fit?:'contain'|'cover';loop?:boolean;autoplay?:boolean;
  shader?:import('./shaders').ShaderEffect;
  scene3d?:import('./scene3d/contract.mjs').Scene3dLayer;
  id: string; type: 'box' | 'text' | 'slot' | 'media' | 'shader' | 'scene3d' | 'chart'; text?: string; slotLabel?: string; slotId?: string; framing?: import('./schema').SlotFraming; appearance?: SourceAppearance;
  styles: Record<string, string | number>; children: RenderNode[]; motionClass?: string;
}
export interface OutputProjection { moduleCommit?:{setEpoch:number;revision:number;domain:'live'|'rehearsal'}; timeline?:AnimationTimeline;assets?:Record<string,import('./assets').MediaAsset>; width: number; height: number; revision: number; root: RenderNode; css: string }

/** Output receives resolved visual data only, never the operator tree or raw state.
 * Any future live adapter must supply an authorized public state projection here.
 */
export function outputProjection(doc: PresentationPackage, state: RehearsalState): OutputProjection {
  const layout = doc.set.layouts.find(l => l.id === state.layoutId);
  if (!layout) throw new Error('No layout selected.');
  const publicState = { ...state, show: { ...state.show,
    total: state.show.revealed ? state.show.total : 0,
    winner: state.show.revealed ? state.show.winner : '',
    result: state.show.revealed ? state.show.result : '' } };
  const css: string[] = [];
  const authored=new Map<string,PresentationNode>(),resolved=new Map<string,string>();const index=(n:PresentationNode)=>{authored.set(n.id,n);n.children?.forEach(index);};index(layout.root);
  let visited = 0;
  const render = (n: PresentationNode, props: Record<string, Scalar>, prefix: string): RenderNode | null => {
    if (++visited > 600) throw new Error('Output node budget exceeded.');
    if (n.when !== undefined) {
      const visible = evaluate(n.when, publicState, props, 64, doc.set.tokens);
      if (typeof visible !== 'boolean') throw new Error('Visibility must be boolean.');
      if (!visible) return null;
    }
    const styles = Object.fromEntries(Object.entries({...doc.set.styles?.[n.styleId??''],...n.styles}).map(([k, v]) => [k, (()=>{const value=safeStyle(k,evaluate(v,publicState,props,64,doc.set.tokens));return k==='letterSpacing'&&typeof value==='number'?`${value}px`:value;})()]));
    // Slash is forbidden in authored IDs, so ancestry cannot alias when IDs
    // contain underscores (a_b/c versus a/b_c).
    const key = `${prefix}/${n.id}`;
    if(authored.get(n.id)===n)resolved.set(n.id,key);
    const animationName = `motion_${key.split('/').map(part => `${part.length}_${part}`).join('_')}`;
    if (n.type === 'component') {
      const def = doc.set.components[n.component!];
      const resolved = { ...def.props };
      for (const [k, v] of Object.entries(n.props ?? {})) {
        resolved[k] = evaluate(v, publicState, props, 64, doc.set.tokens);
        if (typeof resolved[k] !== typeof def.props[k]) throw new Error(`Prop type mismatch: ${k}.`);
      }
      const content = render(def.root, resolved, key);
      const out: RenderNode = { id: key, type: 'box', styles, children: content ? [content] : [] };
      if (n.motion) {
        out.motionClass = animationName;
        css.push(motionCss(out.motionClass, n.motion.property, safeStyle(n.motion.property, n.motion.from), safeStyle(n.motion.property, n.motion.to), n.motion.durationMs, doc.show ? state.elapsedMs : undefined));
      }
      return out;
    }
    const out: RenderNode = { id: key, type: n.type, styles,
      children: (n.children ?? []).flatMap(c => { const child = render(c, props, key); return child ? [child] : []; }) };
    if(n.mask){out.mask=Object.fromEntries(Object.entries(n.mask).map(([k,v])=>[k,typeof v==='object'?evaluate(v,publicState,props,64,doc.set.tokens):v])) as unknown as LayerMask;validateMask(out.mask);}
    if(n.backdrop){out.backdrop={blur:Number(evaluate(n.backdrop.blur,publicState,props,64,doc.set.tokens))};validateBackdrop(out.backdrop);}
    if(n.type==='chart'){
      const spec=n.chart!,chart=resolveChart(chartData(evaluate(spec.data,publicState,props,64,doc.set.tokens)),spec),w=Number(styles.width),h=Number(styles.height);
      const unit=String(spec.unit===undefined?'':evaluate(spec.unit,publicState,props,64,doc.set.tokens)).slice(0,12),zone=String(spec.timeZone===undefined?'UTC':evaluate(spec.timeZone,publicState,props,64,doc.set.tokens));
      const clock=new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:zone});
      const label=(id:string,text:string,x:number,y:number,width:number,align='left'):RenderNode=>({id:key+'/'+id,type:'text',text,styles:{position:'absolute',left:x,top:y,width,height:22,fontFamily:'Arial, sans-serif',fontSize:13,color:'#bed0df',lineHeight:1.15,textAlign:align},children:[]});
      out.type='box';out.children=[{id:key+'/plot',type:'chart',chart,styles:{position:'absolute',left:52,top:12,width:w-64,height:h-42},children:[]}];
      for(let i=0;i<3;i++){const y=chart.yMax-(chart.yMax-chart.yMin)*i/2;out.children.push(label('y-'+i,chart.data.points.some(p=>p.y!==null)?Number(y.toFixed(1))+unit:'—',0,8+(h-44)*i/2,46,'right'));}
      for(let i=0;i<3;i++){const x=chart.xMin+(chart.xMax-chart.xMin)*i/2;out.children.push(label('x-'+i,chart.data.points.length?clock.format(new Date(x)):'—',52+(w-64-78)*i/2,h-25,78,i===2?'right':i===1?'center':'left'));}
    }
    if(n.type==='scene3d'){
      const spec=n.scene3d!,cue=spec.cue===undefined?'neutral':evaluate(spec.cue,publicState,props,64,doc.set.tokens),view=spec.view===undefined?undefined:evaluate(spec.view,publicState,props,64,doc.set.tokens);
      if(typeof cue!=='string'||!(/^[a-z][a-z0-9-]{0,63}$/).test(cue)||(spec.world.cues?!Object.prototype.hasOwnProperty.call(spec.world.cues,cue):cue!=='neutral')||view!==undefined&&(typeof view!=='string'||!spec.world.views?.[view]))throw Error('Invalid resolved 3D cue/view');
      const cueSequence=spec.cueSequence===undefined?undefined:evaluate(spec.cueSequence,publicState,props,64,doc.set.tokens);if(cueSequence!==undefined&&(typeof cueSequence!=='number'||!Number.isSafeInteger(cueSequence)||cueSequence<0))throw Error('Invalid 3D cue sequence');
      out.scene3d={id:spec.id,pass:spec.pass,world:structuredClone(spec.world),cue:cue as string,...(typeof cueSequence==='number'?{cueSequence}:{}),...(typeof view==='string'?{view}:{})};
    }
    if(n.type==='shader')out.shader=structuredClone(n.shader!);
    if(n.type==='media'){out.assetId=n.assetId;out.fit=n.fit??'contain';out.loop=mediaConfig(doc,n.assetId!).loop;out.autoplay=mediaConfig(doc,n.assetId!).start==='entry';if(state.media?.[n.assetId!])out.playback={...state.media[n.assetId!]};}
    if (n.type === 'text') {
      out.text = String(evaluate(n.text!, publicState, props, 64, doc.set.tokens));
      if (out.text.length > 1024) throw new Error('Output text budget exceeded.');
    }
    if (n.type === 'slot') {
      out.slotId = n.slotId;
      if(n.framing) out.framing={...n.framing};
      if (n.appearance) out.appearance = parseSourceAppearance(Object.fromEntries(Object.entries(n.appearance).map(([key,value]) => [key,evaluate(value,publicState,props,64,doc.set.tokens)])));
      out.slotLabel = doc.set.slots.find(s => s.id === n.slotId)!.label;
    }
    if (n.motion) {
      out.motionClass = animationName;
      css.push(motionCss(out.motionClass, n.motion.property, safeStyle(n.motion.property, n.motion.from), safeStyle(n.motion.property, n.motion.to), n.motion.durationMs, doc.show ? state.elapsedMs : undefined));
    }
    return out;
  };
  const root = render(layout.root, {}, 'output');
  if (!root) throw new Error('The output root must be visible.');
  const used=new Set<string>();const collect=(n:RenderNode)=>{if(n.assetId)used.add(n.assetId);n.children.forEach(collect);};collect(root);
  const assets=Object.fromEntries([...used].map(id=>[id,(( {name,mime,data})=>({name,mime,data}))(doc.set.assets![id])]));
  const hasShaders=[...authored.values()].some(n=>n.type==='shader'||n.type==='scene3d'||n.type==='chart');
  const timeline:AnimationTimeline|undefined=layout.animation||hasShaders?{...layout.animation,tracks:(layout.animation?.tracks??[]).filter(t=>resolved.has(t.target)).map(t=>({...t,target:resolved.get(t.target)!})),clock:state.animationClock?{...state.animationClock}:{running:false,positionMs:state.elapsedMs,segmentMs:0,anchorMs:Date.now()}}:undefined;
  const layoutMotion=state.layoutMotions?.[layout.id]??(state.layoutMotionId===layout.id?state.layoutMotion:undefined);
  if(timeline&&layoutMotion){const visible=new Set(resolved.values()),motion=layoutMotion.filter(t=>visible.has(t.target));const keys=new Set(motion.map(t=>`${t.target}:${t.property}`));timeline.tracks=[...timeline.tracks.filter(t=>!keys.has(`${t.target}:${t.property}`)),...motion];}
  if(timeline&&hasShaders&&!doc.show)timeline.clock={...timeline.clock,running:!state.paused};
  return { ...((state.moduleConnection==='live'||state.workspaceMode==='rehearsal')?{moduleCommit:{...state.moduleCommit,domain:state.workspaceMode==='rehearsal'?'rehearsal' as const:'live' as const}}:{}),...(timeline?{timeline}:{}),...(used.size?{assets}:{}),width: layout.width, height: layout.height, revision: state.revision, root, css: css.join('\n') };
}
