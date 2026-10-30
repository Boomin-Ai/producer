export interface PresentedReceipt {
 output:'program'|'portrait';setEpoch:number;revision:number;generation:number;nativeRevision:number;renderSerial:number;
}
export interface FailedPresentationReceipt extends PresentedReceipt {status:'failed';stage:'prepare'|'render';error:string}
/** Missing status remains the original successful wire shape. */
export type PresentationReceipt=PresentedReceipt|FailedPresentationReceipt;
export type ConfirmedPresentation=PresentationReceipt&{at:number;publisher:string};
export type PresentedOutputs=Partial<Record<'program'|'portrait',PresentedReceipt&{at:number;publisher:string}>>;
export type OutputFailures=Partial<Record<'program'|'portrait',FailedPresentationReceipt&{at:number;publisher:string}>>;
export const presentationFailed=(receipt:PresentationReceipt):receipt is FailedPresentationReceipt=>'status'in receipt&&receipt.status==='failed';
export function parsePresentationReceipt(value:unknown):PresentationReceipt {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid output receipt');
 const r=value as Record<string,unknown>,failed=r.status==='failed',keys=['output','setEpoch','revision','generation','nativeRevision','renderSerial',...(failed?['status','stage','error']:[])];
 if(Object.keys(r).length!==keys.length||Object.keys(r).some(k=>!keys.includes(k))||!['program','portrait'].includes(String(r.output)))throw Error('Invalid output receipt');
 for(const k of ['setEpoch','revision','generation','nativeRevision','renderSerial'])if(!Number.isSafeInteger(r[k])||(r[k] as number)<(k==='setEpoch'||!failed&&['nativeRevision','renderSerial'].includes(k)?1:0))throw Error('Invalid output receipt counter');
 if(failed&&(!['prepare','render'].includes(String(r.stage))||typeof r.error!=='string'||!r.error.trim()||r.error.length>500))throw Error('Invalid output failure');
 return {...r} as unknown as PresentationReceipt;
}
/** Revision first; native attempt counters distinguish retry outcomes. */
export function comparePresentation(a:PresentedReceipt,b:PresentedReceipt):number {
 return a.setEpoch-b.setEpoch||a.revision-b.revision||a.generation-b.generation||a.nativeRevision-b.nativeRevision||a.renderSerial-b.renderSerial;
}
/** Native counters belong to one publisher process. A replacement host starts a
 * new counter space; only the server confirmation time orders those outcomes. */
export function compareConfirmedPresentation(a:ConfirmedPresentation,b:ConfirmedPresentation):number {
 return a.setEpoch-b.setEpoch||a.revision-b.revision||(a.publisher===b.publisher?comparePresentation(a,b):a.at-b.at);
}
