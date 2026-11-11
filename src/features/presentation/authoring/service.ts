import {AuthoringSession, type DocumentAdapter} from '../../../../shared/authoring/session';
import {applyDesignEdits, compileDesignPlan, designContext, packageRevision} from './compiler';
import type {AuthoringTarget} from './catalog';
import type {PresentationNode, PresentationPackage} from '../schema';
import {validateAuthoredDefaults} from './validateDefaults';
export {validateAuthoredDefaults} from './validateDefaults';

export type SetAuthoringCommand =
  | {type: 'canonical'; edit: unknown}
  | {type: 'design'; plan: unknown}
  | {type: 'node.properties'; layoutId: string; nodeId: string; properties: Record<string, unknown>}
  | {type: 'animation.track'; layoutId: string; track: unknown};
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function mergeProperties(before:unknown,after:unknown):unknown {
  if(isRecord(before)&&('get' in before||'op' in before)&&!(isRecord(after)&&('get' in after||'op' in after)))throw Error('This property has an authored binding. Edit its value default, or use an explicit canonical edit to change the binding.');
  if(!isRecord(before)||!isRecord(after))return structuredClone(after);
  const next={...before};
  for(const [key,value]of Object.entries(after)) {
    if(['__proto__','prototype','constructor'].includes(key))throw Error('Reserved property key.');
    next[key]=mergeProperties(before[key],value);
  }
  return next;
}

/** Semantic selectors are resolved at the checked document revision. Nodes,
 * controls, per-layout arrangements and runtime definitions remain canonical. */
export function setDocumentAdapter(target: AuthoringTarget): DocumentAdapter<PresentationPackage, SetAuthoringCommand> {
  return {kind: 'producer.presentation/2', revision: packageRevision, validateForCommit(document) {validateAuthoredDefaults(document);}, async apply(base, command) {
    if (!command || typeof command !== 'object') throw Error('Expected an authoring command.');
    const fields:Record<string,string[]>={canonical:['type','edit'],design:['type','plan'],'node.properties':['type','layoutId','nodeId','properties'],'animation.track':['type','layoutId','track']};
    if(!fields[command.type]||Object.keys(command).some(key=>!fields[command.type].includes(key)))throw Error('Unknown authoring command fields.');
    if (command.type === 'canonical') return applyDesignEdits(base, command.edit, target);
    if (command.type === 'design') return compileDesignPlan(command.plan, target, base.set.assets);
    const layoutIndex = base.set.layouts.findIndex(l => l.id === command.layoutId);
    if (layoutIndex < 0) throw Error('Unknown layout ID.');
    const layout = base.set.layouts[layoutIndex], root = `/set/layouts/${layoutIndex}`;
    const operations: Array<{op: 'add' | 'replace'; path: string; value: unknown}> = [];
    if (command.type === 'node.properties') {
      if (!isRecord(command.properties) || !Object.keys(command.properties).length) throw Error('Choose properties to edit.');
      const matches: Array<{node: PresentationNode; path: string}> = [];
      const visit = (node: PresentationNode, path: string) => {if (node.id === command.nodeId) matches.push({node, path}); node.children?.forEach((n, i) => visit(n, `${path}/children/${i}`));};
      visit(layout.root, `${root}/root`);
      if (matches.length !== 1) throw Error('Choose one existing node in this layout.');
      const {node, path} = matches[0];
      for (const [key, value] of Object.entries(command.properties)) {
        if (['id', 'type', 'children', '__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Use canonical edits for structural changes; node identity must stay stable.');
        if (key === 'styles'&&!isRecord(value))throw Error('Styles must be an object.');
        operations.push({op: Object.prototype.hasOwnProperty.call(node,key)?'replace':'add',path:`${path}/${pointer(key)}`,value:mergeProperties((node as unknown as Record<string,unknown>)[key],value)});
      }
    } else if (command.type === 'animation.track') {
      if (!isRecord(command.track) || typeof command.track.target !== 'string' || typeof command.track.property !== 'string') throw Error('An animation track needs a target and property.');
      const track=command.track;
      const animation = structuredClone(layout.animation ?? {tracks: []});
      const index = animation.tracks.findIndex(t => t.target === track.target && t.property === track.property);
      if (index < 0) animation.tracks.push(command.track as typeof animation.tracks[number]);
      else animation.tracks[index] = command.track as typeof animation.tracks[number];
      operations.push({op: layout.animation ? 'replace' : 'add', path: `${root}/animation`, value: animation});
    } else throw Error('Unsupported authoring command.');
    return applyDesignEdits(base, {schema: 'producer.set-edit/2', baseRevision: await packageRevision(base), operations}, target);
  }};
}
export const createSetAuthoringSession = (base: PresentationPackage, target: AuthoringTarget) => AuthoringSession.create(setDocumentAdapter(target), base);
export function inspectAuthoredSet(doc: PresentationPackage) {
  return {context: designContext(doc), layouts: doc.set.layouts.map(layout => {
    const nodes: Array<{id: string; type: string; parent?: string}> = [];
    const visit = (node: PresentationNode, parent?: string) => {nodes.push({id: node.id, type: node.type, ...(parent ? {parent} : {})}); node.children?.forEach(n => visit(n, node.id));};
    visit(layout.root);
    return {id: layout.id, label: layout.label, nodes};
  })};
}
