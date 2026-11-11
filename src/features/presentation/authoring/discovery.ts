import {invoke} from '../../../lib/nativeInvoke';
import {getVersion} from '@tauri-apps/api/app';
import {AUTHORING_CATALOG,type AuthoringTarget} from './catalog';
/** 0.4.78 has no unified native descriptor. This exact-release compatibility
 * manifest is backed by its shipped renderer; unknown releases fail closed. */
export async function discoverAuthoringTarget(workspace:{revision:number;features:string[]}):Promise<AuthoringTarget>{
 try {
  const target=await discoverDesktopAuthoringTarget();
  if(workspace.revision!==target.catalogRevision)throw Error('Workspace authoring catalog changed. Refresh before generating.');
  return {...target,features:target.features.filter(feature=>workspace.features.includes(feature))};
 } catch(error) {
  // Only the explicitly verified legacy profile can use the old descriptor.
  if(await getVersion()!=='0.4.78')throw error;
 }
 const [version,native,effects,scene3d]=await Promise.all([getVersion(),invoke<boolean>('live_set_v2_enabled'),invoke<string[]>('live_set_v2_capabilities'),invoke<boolean>('live_set_v2_scene3d_enabled')]);
 return negotiateAuthoringTarget({version,native,effects,scene3d},workspace);
}
export function nativeAuthoringTarget(value:unknown):AuthoringTarget {
 const profile=value as {schema?:string;catalogRevision?:number;packageSchema?:string;features?:unknown;nativeAdmission?:string};
 if(!profile||profile.schema!=='producer.native-authoring/1'||profile.catalogRevision!==AUTHORING_CATALOG.revision||profile.packageSchema!==AUTHORING_CATALOG.packageSchema||!Array.isArray(profile.features)||!profile.features.every(f=>typeof f==='string')||!profile.features.includes('core@1')||profile.nativeAdmission!=='separate-native-preparation-required')throw Error('This build has no compatible native authoring profile. Install the updated dev build.');
 const available=new Set([...profile.features,...AUTHORING_CATALOG.runtimeCapabilities]);
 return {catalogRevision:AUTHORING_CATALOG.revision,features:AUTHORING_CATALOG.features.filter(f=>available.has(f))};
}
export async function discoverDesktopAuthoringTarget(){return nativeAuthoringTarget(await invoke('assistant_authoring_capabilities'));}
export function negotiateAuthoringTarget(engine:{version:string;native:boolean;effects:string[];scene3d:boolean},workspace:{revision:number;features:string[]}):AuthoringTarget{
 if(engine.version!=='0.4.78'||!engine.native)throw Error('This app has no verified design-compiler capability profile. Update Producer before generating.');
 if(workspace.revision!==AUTHORING_CATALOG.revision||!Array.isArray(workspace.features))throw Error('This workspace needs a matching design compiler update.');
 const available=['core@1',...AUTHORING_CATALOG.runtimeCapabilities,...engine.effects,...(engine.scene3d?['scene3d@1']:[]),...AUTHORING_CATALOG.features.filter(f=>f.startsWith('shader.'))];
 const features=AUTHORING_CATALOG.features.filter(f=>available.includes(f)&&workspace.features.includes(f));
 if(!features.includes('core@1'))throw Error('Workspace cannot generate core layouts.');
 return {catalogRevision:AUTHORING_CATALOG.revision,features};
}
