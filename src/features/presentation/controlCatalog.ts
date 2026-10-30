import {parseControlDefinition,type ControlDefinition} from '../../../shared/set-runtime/control';
import type {PresentationPackage} from './schema';

/** Input must already have passed package validation. Never discard unsupported
 * Show semantics while migrating a live Set to room authority. */
export function controlCatalog(doc:PresentationPackage):ControlDefinition {
 if(doc.set.viewController)throw Error('Module-driven layout control is not supported by shared Set control yet.');
 if(doc.show?.phases.some(p=>p.collectMs!==undefined)||doc.show?.choices.length)throw Error('Voting Shows are not supported by shared Set control yet.');
 return parseControlDefinition({schema:'producer.control/1',layouts:doc.set.layouts.map(l=>l.id),initialLayout:doc.set.initialLayout,
  ...(Object.keys(doc.set.values).length?{fields:Object.fromEntries(Object.entries(doc.set.values).map(([key,field])=>{const control=doc.set.controls.find(c=>c.type!=='button'&&c.key===key);return [key,{...field,...(control?.label.trim()?{label:control.label}:{})}];}))}:{}),
  ...(doc.show?{show:{initialPhase:doc.show.initialPhase,phases:doc.show.phases.map(({id,layoutId,next})=>({id,layoutId,...(next?{next}:{})}))}}:{})});
}
export function availableControlCatalog(doc:PresentationPackage):ControlDefinition|undefined {
 try{return controlCatalog(doc);}catch{return undefined;}
}
