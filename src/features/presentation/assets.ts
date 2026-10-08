export const ASSET_BYTES=12*1024*1024;
export const PACKAGE_BYTES=40*1024*1024;
export type MediaAsset={name:string;mime:string;data:string;playback?:import('./playback').PlaybackConfig};
export const MEDIA_MIMES=['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime','application/lottie+json'];
export function validateAsset(asset:MediaAsset){
 if(/^producer-media:[a-f0-9-]{36}$/.test(asset.data)){if(!MEDIA_MIMES.includes(asset.mime)||asset.mime==='application/lottie+json')throw new Error('Unsupported local media reference.');return;}
 if(!MEDIA_MIMES.includes(asset.mime)||!asset.data.startsWith(`data:${asset.mime};base64,`))throw new Error('Asset must contain an embedded supported media file.');
 const encoded=asset.data.split(',')[1];if(!encoded||encoded.length%4!==0||encoded.length>ASSET_BYTES*4/3+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('Invalid asset or asset exceeds 12 MB.');
 const raw=atob(encoded);if(raw.length>ASSET_BYTES)throw new Error('Asset exceeds 12 MB.');
 if(asset.mime==='application/lottie+json'){
  const animation=JSON.parse(new TextDecoder().decode(Uint8Array.from(raw,c=>c.charCodeAt(0))));
  if(!Array.isArray(animation.layers)||!(animation.w>0&&animation.h>0&&animation.fr>0))throw new Error('Invalid Lottie animation.');
  if(animation.fonts?.list?.length)throw new Error('Convert Lottie text to shapes before importing.');
  const walk=(v:unknown,depth=0)=>{if(depth>40)throw new Error('Lottie nesting exceeds budget.');if(!v||typeof v!=='object')return;for(const [key,value]of Object.entries(v)){if(key==='x'&&typeof value==='string')throw new Error('Lottie expressions are unsupported.');if((key==='u'||key==='p')&&typeof value==='string'&&value&&!value.startsWith('data:image/png;base64,')&&!value.startsWith('data:image/jpeg;base64,')&&!value.startsWith('data:image/webp;base64,'))throw new Error('Lottie must embed its images; external paths are unsupported.');walk(value,depth+1);}};walk(animation);
 }
}
export async function importAsset(file:File):Promise<MediaAsset>{
 if(file.size>ASSET_BYTES)throw new Error('This browser import embeds files up to 12 MB. Use Load media in Producer for full-length files.');
 const mime=file.name.toLowerCase().endsWith('.json')?'application/lottie+json':file.type;
 const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Unable to read media file'));reader.readAsDataURL(file);});
 const asset={name:file.name,mime,data:`data:${mime};base64,${data.split(',')[1]}`};validateAsset(asset);return asset;
}
