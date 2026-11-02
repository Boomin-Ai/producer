import {invoke} from '@tauri-apps/api/core';
import {getVersion} from '@tauri-apps/api/app';
import {AUTHORING_CATALOG,type AuthoringTarget} from './catalog';
/** 0.4.78 has no unified native descriptor. This exact-release compatibility
 * manifest is backed by its shipped renderer; unknown releases fail closed. */
export async function discoverAuthoringTarget(workspace:{revision:number;features:string[]}):Promise<AuthoringTarget>{
 const [version,native,effects,scene3d]=await Promise.all([getVersion(),invoke<boolean>('live_set_v2_enabled'),invoke<string[]>('live_set_v2_capabilities'),invoke<boolean>('live_set_v2_scene3d_enabled')]);
 return negotiateAuthoringTarget({version,native,effects,scene3d},workspace);
}
export function negotiateAuthoringTarget(engine:{version:string;native:boolean;effects:string[];scene3d:boolean},workspace:{revision:number;features:string[]}):AuthoringTarget{
 if(engine.version!=='0.4.78'||!engine.native)throw Error('This app has no verified design-compiler capability profile. Update Producer before generating.');
 if(workspace.revision!==AUTHORING_CATALOG.revision||!Array.isArray(workspace.features))throw Error('This workspace needs a matching design compiler update.');
 const available=['core@1',...AUTHORING_CATALOG.runtimeCapabilities,...engine.effects,...(engine.scene3d?['scene3d@1']:[]),...AUTHORING_CATALOG.features.filter(f=>f.startsWith('shader.'))];
 const features=AUTHORING_CATALOG.features.filter(f=>available.includes(f)&&workspace.features.includes(f));
 if(!features.includes('core@1'))throw Error('Workspace cannot generate core layouts.');
 return {catalogRevision:AUTHORING_CATALOG.revision,features};
}
