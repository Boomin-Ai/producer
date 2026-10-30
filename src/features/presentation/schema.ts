import {validateMask,validateBackdrop} from './visualEffects';
import {arrangementCatalog} from './controlArrangements';
import {parseWorld,WORLD_SCHEMA,type Scene3dWorld} from './scene3d/contract.mjs';
import {parseRuntimeDefinition,type RuntimeDefinition} from '../../../shared/set-runtime/contract';
import {runtimeSchemaBody,runtimeSchemaDefs} from '../../../shared/set-runtime/jsonSchema';
import {outputTypes} from '../../../shared/set-runtime/projection';
import {validateAsset,ASSET_BYTES,PACKAGE_BYTES} from './assets';
import { parseSourceAppearance, sourceAppearanceSchema, type SourceAppearance } from '../../lib/sourceAppearance';
/** One codec describes the import shape, TypeScript type and exported JSON schema.
 * Bounded P0 subset: embedded media, no network/scripts, live effects or private game keys.
 */
type JsonSchema = Record<string, unknown>;
export interface Codec<T> {
  json: JsonSchema;
  read(value: unknown, path: string, depth: number): T;
}
type Type<C> = C extends Codec<infer T> ? T : never;
type Shape = Record<string, Codec<unknown>>;
type Optional<T> = Codec<T | undefined> & { optional: true };
type ObjectType<S extends Shape> =
  { [K in keyof S as S[K] extends { optional: true } ? never : K]: Type<S[K]> } &
  { [K in keyof S as S[K] extends { optional: true } ? K : never]?: Exclude<Type<S[K]>, undefined> };

export class PackageError extends Error {
  constructor(public path: string, message: string) { super(`${path}: ${message}`); }
}
function fail(path: string, message: string): never { throw new PackageError(path, message); }
function bounded(depth: number, path: string) { if (depth > 24) fail(path, 'Structure exceeds 24 levels.'); }
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
export const unsafeKey = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key);
const literal = <T extends string>(value: T): Codec<T> => ({
  json: { const: value }, read: (v, p) => v === value ? value : fail(p, `Expected ${value}.`),
});
const string = (maxLength = 160, pattern?: string): Codec<string> => ({
  json: { type: 'string', maxLength, ...(pattern ? { pattern } : {}) },
  read(v, p) { return typeof v === 'string' && v.length <= maxLength && (!pattern || new RegExp(pattern).test(v))
    ? v : fail(p, 'Invalid or oversized text.'); },
});
const number = (minimum: number, maximum: number): Codec<number> => ({
  json: { type: 'number', minimum, maximum }, read: (v, p) => typeof v === 'number' && Number.isFinite(v) && v >= minimum && v <= maximum
    ? v : fail(p, `Expected a finite number from ${minimum} to ${maximum}.`),
});
const boolean: Codec<boolean> = { json: { type: 'boolean' }, read: (v, p) => typeof v === 'boolean' ? v : fail(p, 'Expected boolean.') };
const optional = <T>(codec: Codec<T>): Optional<T> => ({ ...codec, optional: true,
  read: (v, p, d) => v === undefined ? undefined : codec.read(v, p, d) });
/** Defaults normalize optional authored fields into a complete runtime value. */
const defaulted = <T>(codec:Codec<T>,value:T):Codec<T>&{defaulted:true}=>({
  ...codec,defaulted:true,json:{...codec.json,default:value},
  read:(input,path,depth)=>input===undefined?structuredClone(value):codec.read(input,path,depth),
});
const array = <T>(codec: Codec<T>, maxItems = 64): Codec<T[]> => ({
  json: { type: 'array', items: codec.json, maxItems },
  read(v, p, d) {
    bounded(d, p);
    if (!Array.isArray(v) || v.length > maxItems) fail(p, 'Invalid or oversized list.');
    return v.map((item, i) => codec.read(item, `${p}[${i}]`, d + 1));
  },
});
function plain(v: unknown, p: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(p, 'Expected plain object.');
  if (Object.keys(v).some(unsafeKey)) fail(p, 'Reserved object key.');
}
const object = <S extends Shape>(shape: S): Codec<ObjectType<S>> => ({
  json: { type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, c]) => [k, c.json])),
    required: Object.entries(shape).filter(([, c]) => !('optional' in c)&&!('defaulted' in c)).map(([k]) => k), additionalProperties: false },
  read(v, p, d) {
    bounded(d, p); plain(v, p);
    for (const k of Object.keys(v)) if (!hasOwn(shape, k)) fail(`${p}.${k}`, 'Unknown field.');
    const result: Record<string, unknown> = {};
    for (const [k, c] of Object.entries(shape)) {
      const value = c.read(v[k], `${p}.${k}`, d + 1);
      if (value !== undefined) result[k] = value;
    }
    return result as ObjectType<S>;
  },
});
const union = <C extends Codec<unknown>[]>(...codecs: C): Codec<Type<C[number]>> => ({
  json: { anyOf: codecs.map(c => c.json) },
  read(v, p, d) {
    bounded(d, p);
    // A known discriminator identifies the exact object shape. Preserve its
    // nested error instead of losing it while trying unrelated node types.
    if(v&&typeof v==='object'&&!Array.isArray(v)&&'type'in v){
      const matching=codecs.filter(codec=>(codec.json.properties as Record<string,{const?:unknown}>|undefined)?.type?.const===(v as {type:unknown}).type);
      if(matching.length===1)return matching[0].read(v,p,d) as Type<C[number]>;
    }
    for (const codec of codecs) { try { return codec.read(v, p, d) as Type<C[number]>; } catch (e) { if (!(e instanceof PackageError)) throw e; } }
    return fail(p, 'Unsupported value or invalid fields.');
  },
});
const dictionary = <T>(codec: Codec<T>, maxProperties = 40): Codec<Record<string, T>> => ({
  json: { type: 'object', additionalProperties: codec.json, maxProperties, propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$', not: { enum: ['constructor', 'prototype', '__proto__'] } } },
  read(v, p, d) {
    bounded(d, p); plain(v, p);
    if (Object.keys(v).length > maxProperties) fail(p, 'Too many entries.');
    const result: Record<string, T> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(k)) fail(p, 'Invalid entry name.');
      result[k] = codec.read(val, `${p}.${k}`, d + 1);
    }
    return result;
  },
});
const ref = <T>(name: string, get: () => Codec<T>): Codec<T> => ({
  json: { $ref: `#/$defs/${name}` }, read: (v, p, d) => { bounded(d, p); return get().read(v, p, d); },
});
const id = string(64, '^[a-zA-Z][a-zA-Z0-9_-]{0,63}$');
export type Scalar = string | number | boolean;
const scalar = union(string(512), number(-1e6, 1e6), boolean);
export type Binding = Scalar | { get: string } | { op: 'eq' | 'if' | 'concat'; args: Binding[] };
const binding: Codec<Binding> = union(scalar, object({ get: string(128, '^(values|feeds|props|show|tokens|modules)(\\.[a-zA-Z][a-zA-Z0-9_-]{0,63})+$') }),
  object({ op: union(literal('eq'), literal('if'), literal('concat')), args: array(ref('binding', () => binding), 8) }));
export const STYLE_KEYS = ['position', 'inset', 'left', 'top', 'right', 'bottom', 'width', 'height', 'display', 'gap', 'padding',
  'background', 'color', 'border', 'borderRadius', 'boxShadow', 'fontSize', 'fontWeight', 'letterSpacing', 'textAlign', 'lineHeight',
  'alignItems', 'justifyContent', 'gridTemplateColumns', 'opacity', 'overflow', 'transform', 'minHeight', 'maxWidth', 'fontFamily', 'fontStyle', 'textTransform', 'textShadow', 'whiteSpace', 'wordSpacing', 'backgroundSize', 'backgroundPosition', 'filter', 'mixBlendMode', 'clipPath', 'isolation'] as const;
const styles = dictionary(binding, STYLE_KEYS.length);
const motion = object({ durationMs: number(200, 30_000), property: union(literal('opacity'), literal('transform')),
  from: scalar, to: scalar });
const scene3dWorld:Codec<Scene3dWorld>={json:WORLD_SCHEMA,read(v,p){try{return parseWorld(v);}catch(e){return fail(p,String(e));}}};
const scene3dLayer=object({id:string(53,'^[a-z][a-z0-9-]{0,52}$'),pass:union(literal('background'),literal('foreground')),world:scene3dWorld,cue:optional(binding),view:optional(binding),cueSequence:optional(binding)});
const chart=object({id,kind:union(literal('line'),literal('area'),literal('bar')),unit:optional(binding),timeZone:optional(binding),data:union(string(32768),binding),color:string(9,'^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$'),gridColor:optional(string(9,'^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$')),durationMs:optional(number(0,2000)),lineWidth:optional(number(1,8)),fillOpacity:optional(number(0,.5)),yMin:optional(number(-1e6,1e6)),yMax:optional(number(-1e6,1e6)),windowMs:optional(number(1,604800000))});
const shader=object({effect:union(literal('aurora'),literal('edgeGlow'),literal('lightSweep'),literal('plasma'),literal('silk'),literal('rings'),literal('grid'),literal('stars'),literal('petals'),literal('contours'),literal('prism'),literal('borderFlare'),literal('rain'),literal('snow'),literal('clouds'),literal('voiceBars'),literal('voiceRing')),colors:array(string(7),3),speed:number(0,4),intensity:number(0,2),scale:number(.25,4),opacity:number(0,1),radius:number(0,960),glow:optional(number(0,1)),variant:optional(number(0,14)),bindings:optional(object({intensity:optional(binding),speed:optional(binding),glow:optional(binding)})),quality:union(literal('low'),literal('medium')),clock:union(literal('show'),literal('segment'))});
const layerMask=object({kind:union(literal('rounded'),literal('circle'),literal('wipe')),radius:optional(binding),progress:optional(binding),x:optional(binding),y:optional(binding),feather:optional(binding),invert:optional(binding),direction:optional(union(literal('left'),literal('right'),literal('up'),literal('down')))});
const backdropEffect=object({blur:binding});
const animation=object({tracks:array(object({target:id,property:union(literal('x'),literal('y'),literal('width'),literal('height'),literal('opacity'),literal('scale'),literal('rotation'),literal('shader.intensity'),literal('shader.scale'),literal('mask.progress')),
  keyframes:array(object({atMs:number(0,60_000),value:number(-3840,3840)}),16),easing:optional(union(literal('linear'),literal('easeIn'),literal('easeOut'),literal('easeInOut'))),
  clock:optional(union(literal('show'),literal('segment'))),delayMs:optional(number(0,60_000)),loop:optional(union(literal('none'),literal('repeat'),literal('pingpong')))}),32),transition:optional(object({type:union(literal('cut'),literal('crossfade'),literal('morph')),durationMs:number(0,2000),contentDurationMs:optional(number(0,1000))}))});
export interface SlotFraming { mode:'fill'|'fit'; x:number; y:number }
const framing = object({mode:union(literal('fill'),literal('fit')),x:number(0,1),y:number(0,1)});
export interface PresentationNode {
  id: string; type: 'box' | 'text' | 'slot' | 'component' | 'media' | 'shader' | 'scene3d' | 'chart';
  mask?:Type<typeof layerMask>;backdrop?:Type<typeof backdropEffect>;
  chart?:Type<typeof chart>;
  shader?:import('./shaders').ShaderEffect;
  scene3d?:{id:string;pass:'background'|'foreground';world:Scene3dWorld;cue?:Binding;view?:Binding;cueSequence?:Binding};
  styleId?: string; styles?: Record<string, Binding>; text?: Binding; children?: PresentationNode[];
  assetId?:string;fit?:'contain'|'cover';loop?:boolean;autoplay?:boolean;
  slotId?: string; framing?:SlotFraming; appearance?: Partial<Record<keyof SourceAppearance, Binding>>; component?: string; props?: Record<string, Binding>; when?: Binding;
  motion?: Type<typeof motion>;
}
const common = { id, styleId:optional(id), styles: optional(styles),mask:optional(layerMask),backdrop:optional(backdropEffect), when: optional(binding), motion: optional(motion) };
const appearance: Codec<Partial<Record<keyof SourceAppearance, Binding>>> = {
  json: { ...sourceAppearanceSchema, properties: Object.fromEntries(Object.entries(sourceAppearanceSchema.properties).map(([k,s]) =>
    [k, { anyOf: [s, { allOf: [{ type: 'object' }, { $ref: '#/$defs/binding' }] }] }])) },
  read(v,p,d) {
    bounded(d,p); plain(v,p);
    const result: Partial<Record<keyof SourceAppearance, Binding>> = {};
    for (const [key, value] of Object.entries(v)) {
      if (!hasOwn(sourceAppearanceSchema.properties,key)) fail(p, `Unknown appearance field ${key}.`);
      if (value && typeof value === 'object') result[key as keyof SourceAppearance] = binding.read(value, `${p}.${key}`, d+1);
      else {
        try { parseSourceAppearance({ [key]: value }); }
        catch(e) { fail(p, e instanceof Error ? e.message : 'Invalid source appearance.'); }
        result[key as keyof SourceAppearance] = value as Scalar;
      }
    }
    return result;
  },
};
const node: Codec<PresentationNode> = union(
  object({ ...common, type: literal('box'), children: array(ref('node', () => node), 100) }),
  object({ ...common, type: literal('text'), text: binding }),
  object({ ...common, type: literal('slot'), slotId: id, framing: optional(framing), appearance: optional(appearance) }),
  object({ ...common, type: literal('chart'),chart }),
  object({ ...common, type: literal('shader'),shader:shader }),
  object({ ...common, type: literal('scene3d'),scene3d:scene3dLayer }),
  object({ ...common, type: literal('media'),assetId:id,fit:optional(union(literal('contain'),literal('cover'))),loop:optional(boolean),autoplay:optional(boolean) }),
  object({ ...common, type: literal('component'), component: id, props: dictionary(binding) }),
);
const valueDefinition = union(
  object({ type: literal('text'), default: string(160), maxLength: number(1, 160) }),
  object({ type: literal('number'), default: number(-1e6, 1e6), min: number(-1e6, 1e6), max: number(-1e6, 1e6) }),
  object({ type: literal('boolean'), default: boolean }),
);
const action = union(object({ type: literal('layout.select'), layoutId: id }),
  object({ type: literal('value.set'), key: id, value: scalar }),
  object({ type: literal('show.start') }), object({ type: literal('show.next') }), object({ type: literal('show.previous') }),
  object({ type: literal('show.vote'), choiceId: id }), object({ type: literal('show.reveal') }),
  object({ type: literal('show.reopen') }), object({ type: literal('show.tiebreak') }), object({ type: literal('show.draw') }));
export type RehearsalAction = Type<typeof action>;
const control = union(
  object({ id, type: literal('button'), label: string(80), action, when: optional(binding), enabled: optional(binding) }),
  object({ id, type: literal('text'), label: string(80), key: id, when: optional(binding) }),
  object({ id, type: literal('number'), label: string(80), key: id, when: optional(binding) }),
);
export type SetControl = Type<typeof control>;
const controlReference=string(210,'^(builtin:layout|set:[a-zA-Z][a-zA-Z0-9_-]{0,63}|module:[a-zA-Z][a-zA-Z0-9_-]{0,63}:([a-zA-Z][a-zA-Z0-9_-]{0,63}|\\$(lifecycle|weather-location|behavior-tools)))$');
const controlArrangement=object({sections:array(object({id,label:string(80),controls:array(controlReference,256),collapsed:optional(boolean)}),64),minimized:array(controlReference,64)});
const show = object({ id, version: string(32), initialPhase: id,
  phases: array(object({ id, label: string(80), layoutId: id, next: optional(id), collectMs: optional(number(1000, 3_600_000)) }), 16),
  choices: defaulted(array(object({ id, label: string(80) }), 6), []),
});
const moduleCodec:Codec<RuntimeDefinition>={json:runtimeSchemaBody,read(v,p){try{return parseRuntimeDefinition(v);}catch(error){return fail(p,error instanceof Error?error.message:'Invalid module configuration');}}};
const codec = object({
  schema: literal('producer.presentation/2'),requires:optional(array(union(literal('mask@1'),literal('backdrop@1'),literal('chart@1')),3)), runtime:defaulted(moduleCodec,{schema:'producer.modules/1',definitions:{},instances:[]}), id, version: string(32), name: string(80),
  set: object({ viewController:optional(id),views:optional(dictionary(object({landscape:optional(id),portrait:optional(id),square:optional(id)}),32)),initialView:optional(id),styles:optional(dictionary(styles,32)), tokens:optional(dictionary(union(string(240),number(-10000,10000)),64)), assets:optional(dictionary(object({name:string(160),mime:string(40),data:string(ASSET_BYTES*4/3+100),playback:optional(object({start:union(literal('entry'),literal('manual')),loop:boolean,exit:union(literal('reset'),literal('pause'),literal('continue')),return:union(literal('restart'),literal('resume')),hostControls:boolean}))}),24)),initialLayout: id, values: dictionary(valueDefinition),
    feeds: dictionary(valueDefinition), slots: array(object({ id, label: string(80) }), 8),
    components: dictionary(object({ props: dictionary(scalar), root: ref('node', () => node) }), 16),
    layouts: array(object({ id, label: string(80), width: number(320, 1920), height: number(320, 1920), root: ref('node', () => node),animation:optional(animation) }), 32),
    controls: array(control, 40),controlArrangement:optional(controlArrangement),
  }), show: optional(show),
});
export type PresentationPackage = Type<typeof codec>;
export type ValueDefinition = Type<typeof valueDefinition>;
export const presentationJsonSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...codec.json,
  $defs: { ...runtimeSchemaDefs,binding: binding.json, node: node.json } };

export function parsePackage(value: unknown): PresentationPackage {
  const doc = codec.read(value, '$', 0);
  if(doc.set.controlArrangement){
    const known=new Set(arrangementCatalog(doc).controls.map(c=>c.id));
    const sections=new Set<string>(),placed=new Set<string>(),minimized=new Set<string>();
    for(const section of doc.set.controlArrangement.sections){
      if(sections.has(section.id)||!section.label.trim())fail('$.set.controlArrangement.sections','Duplicate section or empty label.');sections.add(section.id);
      for(const ref of section.controls){if(!known.has(ref)||placed.has(ref))fail('$.set.controlArrangement.sections','Unknown or repeated control reference.');placed.add(ref);}
    }
    for(const ref of doc.set.controlArrangement.minimized){if(!known.has(ref)||minimized.has(ref))fail('$.set.controlArrangement.minimized','Unknown or repeated control reference.');minimized.add(ref);}
  }
  const decorative = new Set(['background','color','border','borderRadius','boxShadow','fontSize','fontWeight','letterSpacing','textAlign','lineHeight','fontFamily','fontStyle','textTransform','textShadow','whiteSpace','wordSpacing','backgroundSize','backgroundPosition']);
  for(const preset of Object.values(doc.set.styles??{})) for(const key of Object.keys(preset)) if(!decorative.has(key)) fail('$.set.styles',`Style presets cannot change geometry or compositing: ${key}.`);
  if (new TextEncoder().encode(JSON.stringify(doc)).length > PACKAGE_BYTES) fail('$','Set package exceeds 40 MB.');
  for(const asset of Object.values(doc.set.assets??{})){try{validateAsset(asset);}catch(e){fail('$.set.assets',String(e));}}
  const phaseIds=new Set(doc.show?.phases.map(p=>p.id)??[]);
  for(const definition of Object.values(doc.runtime.definitions))for(const group of definition.controls)for(const control of group.controls){
    if(control.segment&&!phaseIds.has(control.segment))fail('$.runtime.controls','Control refers to an unknown show segment.');
  }
  const layouts = new Set<string>();
  let expanded = 0;
  const checkBinding = (b: Binding, scope: Set<string>) => {
    if (typeof b !== 'object') return;
    if ('get' in b) {
      const [root, key, ...rest] = b.get.split('.');
      if(root==='modules'){
        const instance=doc.runtime.instances.find(i=>i.id===key);
        if(rest.length!==1||!instance||unsafeKey(rest[0])||!hasOwn(outputTypes(doc.runtime.definitions[instance.definition]),rest[0]))fail('$',`Unknown module output binding ${b.get}.`);
        return;
      }
      if (rest.length || unsafeKey(key) || (root === 'props' ? !scope.has(key) : root === 'values' ? !hasOwn(doc.set.values, key)
        : root === 'feeds' ? !hasOwn(doc.set.feeds, key) : root === 'tokens' ? !hasOwn(doc.set.tokens??{},key) : !doc.show || !['layoutId', 'phase', 'collecting', 'revealed', 'winner', 'result', 'ballot', 'heat', 'remainingMs', 'total'].includes(key))) fail('$', `Unknown binding ${b.get}.`);
    } else {
      if (b.op === 'eq' && b.args.length !== 2 || b.op === 'if' && b.args.length !== 3) fail('$', 'Wrong binding argument count.');
      b.args.forEach(x => checkBinding(x, scope));
    }
  };
  const bindingType = (b: Binding, props: Record<string, Scalar> = {}): string => {
    if (typeof b !== 'object') return typeof b;
    if ('get' in b) {
      const [root, key,field] = b.get.split('.');
      if(root==='modules'){const instance=doc.runtime.instances.find(i=>i.id===key);const type=instance?outputTypes(doc.runtime.definitions[instance.definition])[field]:undefined;return type==='text'?'string':type??'undefined';}
      if (root === 'props') return typeof props[key];
      if (root === 'tokens') return typeof doc.set.tokens?.[key];
      if (root === 'show') return ['layoutId', 'phase', 'winner', 'result'].includes(key) ? 'string' : ['collecting', 'revealed'].includes(key) ? 'boolean' : 'number';
      const def = (root === 'values' ? doc.set.values : doc.set.feeds)[key];
      return def?.type === 'text' ? 'string' : def?.type ?? 'undefined';
    }
    if (b.op === 'eq') return 'boolean';
    if (b.op === 'concat') return 'string';
    if (bindingType(b.args[0], props) !== 'boolean') fail('$', 'Condition must be boolean.');
    const a = bindingType(b.args[1], props), c = bindingType(b.args[2], props);
    if (a !== c) fail('$', 'Conditional branches must have matching types.');
    return a;
  };
  const booleanBinding = (b: Binding, props: Record<string, Scalar> = {}) => {
    if (bindingType(b, props) !== 'boolean') fail('$', 'Visibility/enabled binding must be boolean.');
  };
  for(const preset of Object.values(doc.set.styles??{}))for(const [key,value] of Object.entries(preset)){checkBinding(value,new Set());if(bindingType(value)==='boolean')fail('$.set.styles','Styles must be text or numbers.');if(typeof value!=='object')safeStyle(key,value);}
  const slots = new Set<string>();
  doc.set.slots.forEach(s => { if (slots.has(s.id)) fail('$.set.slots', 'Duplicate slot ID.'); slots.add(s.id); });
  const walk = (n: PresentationNode, props: Record<string, Scalar>, stack: string[], ids: Set<string>) => {
    if(n.styleId){const preset=doc.set.styles?.[n.styleId];if(!preset)fail('$.set',`Unknown style preset ${n.styleId}.`);n={...n,styles:{...preset,...n.styles}};}
    const hasNative=(node:PresentationNode,seen=new Set<string>()):boolean=>node.type==='slot'||node.type==='shader'||node.type==='scene3d'||node.type==='chart'||!!node.children?.some(c=>hasNative(c,seen))||(node.type==='component'&&!seen.has(node.component!)&&(seen.add(node.component!),hasNative(doc.set.components[node.component!]?.root??{id:'empty',type:'box'},seen)));
    if(n.mask||n.backdrop){
      if(n.type!=='box'&&n.type!=='slot'&&n.type!=='media')fail('$.set','Layer effects require a box, slot or media element.');
      if(n.mask&&!doc.requires?.includes('mask@1'))fail('$.requires','Declare mask@1 for layer masks.');
      if(n.backdrop&&!doc.requires?.includes('backdrop@1'))fail('$.requires','Declare backdrop@1 for backdrop effects.');
      try{if(n.mask)validateMask(Object.fromEntries(Object.entries(n.mask).map(([k,v])=>[k,typeof v==='object'?(k==='invert'?false:k==='progress'?1:k==='x'||k==='y'?.5:0):v])) as unknown as import('./visualEffects').LayerMask);if(n.backdrop&&typeof n.backdrop.blur==='number')validateBackdrop(n.backdrop as {blur:number});}catch(e){fail('$.set',String(e));}
    }
    if(['filter','mixBlendMode','clipPath'].some(k=>n.styles?.[k]!==undefined)&&hasNative(n))fail('$.set','Graphic compositing effects cannot wrap native video or shader layers.');
    const scope = new Set(Object.keys(props));
    if (++expanded > 600) fail('$.set', 'Expanded output exceeds 600 nodes.');
    if (ids.has(n.id)) fail('$.set', `Duplicate node ID ${n.id}.`); ids.add(n.id);
    for(const [key,v]of Object.entries(n.mask??{})){if(['kind','direction'].includes(key))continue;checkBinding(v as Binding,scope);if(bindingType(v as Binding,props)!==(key==='invert'?'boolean':'number'))fail('$.set','Invalid mask binding type');}
    if(n.backdrop){checkBinding(n.backdrop.blur,scope);if(bindingType(n.backdrop.blur,props)!=='number')fail('$.set','Blur must be numeric.');}
    if (n.when !== undefined) { checkBinding(n.when, scope); booleanBinding(n.when, props); }
    for (const [k, v] of Object.entries(n.styles ?? {})) {
      if (!(STYLE_KEYS as readonly string[]).includes(k)) fail('$.set', `Unsupported style ${k}.`);
      if (n.type === 'slot' && !['position','left','top','right','bottom','width','height'].includes(k))
        fail('$.set', `Media slot style ${k} is unsupported; use appearance for native video effects.`);
      checkBinding(v, scope);
      if (bindingType(v, props) === 'boolean') fail('$.set', 'Styles must be text or numbers.');
      if (typeof v !== 'object') safeStyle(k, v);
    }
    if (n.motion) { safeStyle(n.motion.property, n.motion.from); safeStyle(n.motion.property, n.motion.to); }
    if (n.type === 'text') { checkBinding(n.text!, scope); bindingType(n.text!, props); }
    if(n.type==='media'&&!doc.set.assets?.[n.assetId!])fail('$.set','Missing media asset.');
    if(n.type==='chart'){
      if(!doc.requires?.includes('chart@1'))fail('$.requires','Declare chart@1 for chart layers.');
      for(const label of [n.chart!.unit,n.chart!.timeZone])if(label!==undefined){checkBinding(label,scope);if(bindingType(label,props)!=='string')fail('$.set','Chart labels must be text.');}
      if(n.styles?.position!=='absolute'||['left','top','width','height'].some(k=>typeof n.styles?.[k]!=='number')||Number(n.styles?.width)<160||Number(n.styles?.height)<100||Number(n.styles?.width)>4096||Number(n.styles?.height)>4096)fail('$.set','Charts require bounded numeric absolute geometry.');
      checkBinding(n.chart!.data,scope);if(bindingType(n.chart!.data,props)!=='string')fail('$.set','Chart data must be public JSON text.');
      if(n.chart!.yMin!==undefined&&n.chart!.yMax!==undefined&&n.chart!.yMin>=n.chart!.yMax)fail('$.set','Chart vertical range must increase.');
    }
    if(n.type==='scene3d'){
      if(['constructor','prototype'].includes(n.scene3d!.id))fail('$.set','Invalid 3D identity.');
      if(Number(n.styles?.width)<16||Number(n.styles?.height)<16)fail('$.set','3D surfaces require at least 16 pixels per side.');
      for(const value of [n.scene3d!.cue,n.scene3d!.view])if(value!==undefined){checkBinding(value,scope);if(bindingType(value,props)!=='string')fail('$.set','3D cue/view bindings must resolve to text.');}
      if(n.scene3d?.cueSequence!==undefined){checkBinding(n.scene3d.cueSequence,scope);if(bindingType(n.scene3d.cueSequence,props)!=='number')fail('$.set','3D cue sequence must be numeric.');}
      if(n.styles?.position!=='absolute'||['left','top','width','height'].some(k=>typeof n.styles?.[k]!=='number'))fail('$.set','3D layers require numeric absolute geometry.');
      if(Object.keys(n.styles??{}).some(k=>!['position','left','top','width','height'].includes(k)))fail('$.set','3D layers own their compositing effects.');
    }
    if(n.type==='shader'){
      if(n.shader!.variant!==undefined&&!Number.isInteger(n.shader!.variant))fail('$.set','Shader variants require a whole number.');
      for(const value of Object.values(n.shader!.bindings??{})){checkBinding(value,scope);if(bindingType(value,props)!=='number')fail('$.set','Shader parameter bindings must be numeric.');}
      if(n.shader!.colors.length!==3||n.shader!.colors.some(c=>!/^#[0-9a-f]{6}$/i.test(c)))fail('$.set','Shader colors require three hex colors.');
      if(n.styles?.position!=='absolute'||['left','top','width','height'].some(k=>typeof n.styles?.[k]!=='number'))fail('$.set','Shader layers require numeric absolute geometry.');
      if(Object.keys(n.styles??{}).some(k=>!['position','left','top','width','height'].includes(k)))fail('$.set','Use shader opacity and radius rather than CSS effects.');
    }
    if (n.type === 'slot' && !slots.has(n.slotId!)) fail('$.set', 'Unknown media slot.');
    for (const [key, value] of Object.entries(n.appearance ?? {})) {
      checkBinding(value,scope);
      const expected = key === 'shape' || key === 'outlineColor' ? 'string' : 'number';
      if (bindingType(value,props) !== expected) fail('$.set', `Appearance ${key} must be ${expected}.`);
    }
    if (n.type === 'component') {
      const name = n.component!;
      if (!hasOwn(doc.set.components, name) || stack.includes(name)) fail('$.set', 'Missing or cyclic component.');
      const def = doc.set.components[name];
      for (const [key, v] of Object.entries(n.props ?? {})) {
        if (!hasOwn(def.props, key)) fail('$.set', `Unknown component prop ${key}.`); checkBinding(v, scope);
        if (bindingType(v, props) !== typeof def.props[key]) fail('$.set', `Component prop type mismatch: ${key}.`);
      }
      walk(def.root, def.props, [...stack, name], new Set());
    }
    n.children?.forEach(c => walk(c, props, stack, ids));
  };
  for (const layout of doc.set.layouts) {
    if (layouts.has(layout.id)) fail('$.set.layouts', 'Duplicate layout ID.'); layouts.add(layout.id);
    if (!Number.isInteger(layout.width) || !Number.isInteger(layout.height)) fail('$.set.layouts', 'Output dimensions must be integer pixels.');
    walk(layout.root, {}, [], new Set());
    const nodes=new Map<string,PresentationNode>();const collect=(n:PresentationNode)=>{nodes.set(n.id,n);n.children?.forEach(collect);};collect(layout.root);
    const backdropNodes=[...nodes.values()].filter(n=>n.backdrop);
    if(backdropNodes.length>4)fail('$.set','At most four backdrop panels per layout.');
    if([...nodes.values()].filter(n=>n.mask).length>16)fail('$.set','At most sixteen masks per layout.');
    for(const n of backdropNodes){if(n===layout.root)fail('$.set','A root has no local backdrop.');if(n.styles?.transform!==undefined||n.motion)fail('$.set','Backdrop panels cannot transform.');}
    const worlds=[...nodes.values()].filter(n=>n.type==='scene3d');
    const worldKeys=worlds.map(n=>n.scene3d!.id+'-'+n.scene3d!.pass);
    if(new Set(worldKeys).size!==worldKeys.length)fail('$.set.layouts','Duplicate 3D pass.');
    if(worlds.length>2||worlds.some(n=>!layout.root.children?.includes(n)))fail('$.set.layouts','Up to two 3D passes belong directly under the layout root.');
    const charts=[...nodes.values()].filter(n=>n.type==='chart');if(charts.length>4||new Set(charts.map(n=>n.chart!.id)).size!==charts.length)fail('$.set.layouts','Use at most four uniquely identified chart layers.');
    const shaderNodes=[...nodes.values()].filter(n=>n.type==='shader');
    if(shaderNodes.length>4||shaderNodes.some(n=>!layout.root.children?.includes(n)))fail('$.set.layouts','Up to four shader layers belong directly under the layout root.');
    if(shaderNodes.length&&(layout.root.styles?.position!=='relative'||layout.root.styles?.transform!==undefined||layout.root.styles?.opacity!==undefined&&layout.root.styles.opacity!==1||layout.root.motion))fail('$.set.layouts','Shader layouts require a plain relative root.');
    if(shaderNodes.length&&(layout.root.styles?.width!==layout.width||layout.root.styles?.height!==layout.height||Object.keys(layout.root.styles??{}).some(k=>!['position','width','height','background','overflow'].includes(k))))fail('$.set.layouts','Shader roots must match the canvas without padding or CSS transforms.');
    for(const n of shaderNodes){const s=n.styles!;if(Number(s.left)<0||Number(s.top)<0||Number(s.width)<1||Number(s.height)<1||Number(s.left)+Number(s.width)>layout.width||Number(s.top)+Number(s.height)>layout.height)fail('$.set.layouts','Shader geometry must fit inside the canvas.');}
    const animated=new Set<string>();
    for(const track of layout.animation?.tracks??[]){
      const target=nodes.get(track.target);if(!target)fail('$.set.layouts.animation','Animation target must belong to the layout.');
      const key=`${track.target}:${track.property}`;if(animated.has(key))fail('$.set.layouts.animation','Duplicate animation property.');animated.add(key);
      if(track.keyframes.length<2||track.keyframes[0].atMs!==0||track.keyframes.some((f,i)=>i>0&&f.atMs<=track.keyframes[i-1].atMs))fail('$.set.layouts.animation','Keyframes must start at zero and increase.');
      for(const f of track.keyframes)if(track.property==='opacity'&&(f.value<0||f.value>1)||track.property==='scale'&&(f.value<.05||f.value>8)||['width','height'].includes(track.property)&&f.value<1)fail('$.set.layouts.animation','Animation value is outside its property range.');
      if(track.property==='mask.progress'&&(!target!.mask||target!.mask.kind==='rounded'||track.keyframes.some(f=>f.value<0||f.value>1)))fail('$.set.layouts.animation','Mask animation requires a mask and normalized progress.');
      if(target!.backdrop&&['x','y','width','height','rotation','scale'].includes(track.property))fail('$.set.layouts.animation','Backdrop geometry must be static; animate its mask or opacity.');
      if(track.property.startsWith('shader.')&&(target!.type!=='shader'||track.keyframes.some(f=>track.property==='shader.intensity'?(f.value<0||f.value>2):(f.value<.25||f.value>4))))fail('$.set.layouts.animation','Shader tracks require a shader target and bounded values.');
      const hasSlot=(n:PresentationNode):boolean=>n.type==='slot'||n.type==='shader'||n.type==='scene3d'||!!n.children?.some(hasSlot)||n.type==='component';
      if(track.property!=='mask.progress'&&!['slot','shader'].includes(target!.type)&&hasSlot(target!))fail('$.set.layouts.animation','Animate native layers directly; animated ancestors are unsupported.');
      if(['x','y','width','height'].includes(track.property)&&target!.styles?.position!=='absolute')fail('$.set.layouts.animation','Geometry tracks require an absolute element.');
      if(target!.type==='slot'&&['x','y'].includes(track.property)&&typeof target!.styles?.[track.property==='x'?'left':'top']!=='number')fail('$.set.layouts.animation','Source position tracks require numeric left and top.');
    }
  }
  // Unused component definitions are checked too, rather than hiding unsafe nodes.
  for (const [name, def] of Object.entries(doc.set.components)){const hasShader=(n:PresentationNode):boolean=>n.type==='shader'||!!n.children?.some(hasShader);if(hasShader(def.root))fail('$.set.components','Shader layers belong directly under a layout root.');walk(def.root, def.props, [name], new Set());}
  if (!layouts.has(doc.set.initialLayout)) fail('$.set.initialLayout', 'Unknown layout.');
  for(const [view,variants]of Object.entries(doc.set.views??{})){
    if(!Object.keys(variants).length)fail('$.set.views','A view needs at least one variant.');
    for(const [orientation,layoutId]of Object.entries(variants)){const layout=doc.set.layouts.find(l=>l.id===layoutId);if(!layout)fail('$.set.views',`Unknown layout in ${view}.`);const actual=layout.width>layout.height?'landscape':layout.width<layout.height?'portrait':'square';if(actual!==orientation)fail('$.set.views','View variant orientation does not match its canvas.');}
  }
  for(const instance of doc.runtime.instances)for(const segment of instance.audienceSegments??[])if(!doc.show?.phases.some(p=>p.id===segment))fail('$.runtime.instances','Audience exposure names an unknown show segment.');
  if(doc.set.viewController){const owner=doc.runtime.instances.find(i=>i.id===doc.set.viewController);if(!owner||owner.owner!=='set')fail('$.set.viewController','Canvas view control requires a set-owned module.');const module=doc.runtime.definitions[owner!.definition];if(!module.views?.length||module.views.some(view=>!doc.set.views?.[view]))fail('$.set.viewController','Every controlled view needs an authored canvas variant.');}
  if(doc.set.initialView){const view=doc.set.views?.[doc.set.initialView];if(!view||!Object.values(view).includes(doc.set.initialLayout))fail('$.set.initialView','Initial view and layout do not match.');}
  for(const instance of doc.runtime.instances)if(instance.owner==='segment'&&!doc.show?.phases.some(p=>p.id===instance.segment))fail('$.runtime.instances','Module owns an unknown show segment.');
  for (const [key, def] of [...Object.entries(doc.set.values), ...Object.entries(doc.set.feeds)]) validateValue(def, def.default, key);
  const controls = new Set<string>();
  doc.set.controls.forEach(c => {
    if (controls.has(c.id)) fail('$.set.controls', 'Duplicate control ID.'); controls.add(c.id);
    if (c.when !== undefined) { checkBinding(c.when, new Set()); booleanBinding(c.when); }
    if ('enabled' in c && c.enabled !== undefined) { checkBinding(c.enabled, new Set()); booleanBinding(c.enabled); }
    if (c.type !== 'button') {
      const def = doc.set.values[c.key];
      if (!def || def.type !== c.type) fail('$.set.controls', 'Control value/type does not match declared field.');
    } else if (c.action.type === 'layout.select' && !layouts.has(c.action.layoutId)) fail('$.set.controls', 'Unknown layout action.');
    else if (c.action.type === 'value.set') {
      if (!hasOwn(doc.set.values, c.action.key)) fail('$.set.controls', 'Unknown value action.');
      validateValue(doc.set.values[c.action.key], c.action.value, c.action.key);
    } else if (c.action.type.startsWith('show.') && !doc.show) fail('$.set.controls', 'Show action without show module.');
  });
  if (doc.show) {
    const phases = new Set<string>(), choices = new Set<string>();
    doc.show.phases.forEach(p => { if (phases.has(p.id) || !layouts.has(p.layoutId)) fail('$.show.phases', 'Duplicate phase or missing layout.'); phases.add(p.id); });
    if (!phases.has(doc.show.initialPhase)) fail('$.show', 'Unknown initial phase.');
    doc.show.phases.forEach(p => { if (p.next && !phases.has(p.next)) fail('$.show', 'Unknown next phase.'); });
    doc.show.choices.forEach(c => { if (choices.has(c.id)) fail('$.show', 'Duplicate choice.'); choices.add(c.id); });
    if ((choices.size>0||doc.show.phases.some(p=>p.collectMs!==undefined))&&choices.size<2) fail('$.show.choices', 'Voting needs at least two choices. A sequence without voting needs none.');
    for (const c of doc.set.controls) if (c.type === 'button' && c.action.type === 'show.vote' && !choices.has(c.action.choiceId)) fail('$.set.controls', 'Unknown choice.');
  }
  return doc;
}
export function validateValue(def: ValueDefinition, value: unknown, path: string): Scalar {
  if (def.type === 'text' && typeof value === 'string' && value.length <= def.maxLength) return value;
  if (def.type === 'boolean' && typeof value === 'boolean') return value;
  if (def.type === 'number' && typeof value === 'number' && Number.isFinite(value) && def.min <= def.max && value >= def.min && value <= def.max) return value;
  return fail(path, 'Value does not match the declared type/bounds.');
}
export function safeStyle(key: string, value: Scalar): string | number {
  if (!(STYLE_KEYS as readonly string[]).includes(key) || typeof value === 'boolean') fail('style', 'Unsupported property/value.');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 10_000 || key === 'opacity' && (value < 0 || value > 1)) fail('style', 'Style exceeds bounds.');
    return value;
  }
  if (value.length > 240 || /[\\/;{}<>@\u0000-\u001f]|(?:url|expression|image|image-set|-webkit-image-set|cross-fade|paint|element)\s*\(|(?:https?|file|data|javascript):/i.test(value)) fail('style', 'Resource URLs and CSS injection are forbidden.');
  for (const match of value.matchAll(/(?:^|[\s,(])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi)) {
    if (Math.abs(Number(match[1])) > 10_000) fail('style', 'Style exceeds bounds.');
  }
  return value;
}
