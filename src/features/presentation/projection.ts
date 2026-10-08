import {mediaConfig} from './playback';
import { parseSourceAppearance, type SourceAppearance } from '../../lib/sourceAppearance';
import { evaluate, type RehearsalState } from './rehearsal';
import { safeStyle, type PresentationPackage, type PresentationNode, type Scalar } from './schema';
import { motionCss } from './nordcraft-adapter/motion';
import {type AnimationTimeline} from './animation';

export interface RenderNode {
  playback?:import('./playback').MediaTransport;
  assetId?:string;fit?:'contain'|'cover';loop?:boolean;autoplay?:boolean;
  shader?:import('./shaders').ShaderEffect;
  id: string; type: 'box' | 'text' | 'slot' | 'media' | 'shader'; text?: string; slotLabel?: string; slotId?: string; framing?: import('./schema').SlotFraming; appearance?: SourceAppearance;
  styles: Record<string, string | number>; children: RenderNode[]; motionClass?: string;
}
export interface OutputProjection { timeline?:AnimationTimeline;assets?:Record<string,import('./assets').MediaAsset>; width: number; height: number; revision: number; root: RenderNode; css: string }

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
  const hasShaders=[...authored.values()].some(n=>n.type==='shader');
  const timeline:AnimationTimeline|undefined=layout.animation||hasShaders?{...layout.animation,tracks:(layout.animation?.tracks??[]).filter(t=>resolved.has(t.target)).map(t=>({...t,target:resolved.get(t.target)!})),clock:state.animationClock?{...state.animationClock}:{running:false,positionMs:state.elapsedMs,segmentMs:0,anchorMs:Date.now()}}:undefined;
  if(timeline&&state.layoutMotion&&state.layoutMotionId===layout.id){const visible=new Set(resolved.values()),motion=state.layoutMotion.filter(t=>visible.has(t.target));const keys=new Set(motion.map(t=>`${t.target}:${t.property}`));timeline.tracks=[...timeline.tracks.filter(t=>!keys.has(`${t.target}:${t.property}`)),...motion];}
  if(timeline&&hasShaders&&!doc.show)timeline.clock={...timeline.clock,running:true};
  return { ...(timeline?{timeline}:{}),...(used.size?{assets}:{}),width: layout.width, height: layout.height, revision: state.revision, root, css: css.join('\n') };
}
