import type {Field, ModuleBindings} from './contract';
import type {DataAdapterManifest} from './dataAdapters';
export interface SocialConnection {id:string;name:string;kind:'social';provider:'threads';pollSeconds:number}
export type SocialQuery={postId?:string;rangeDays?:7|30};
export const SOCIAL_METRICS=['views','likes','replies','reposts','quotes','clicks','followers_count'] as const;
export const POST_METRICS=['views','likes','replies','reposts','quotes','shares'] as const;
export type Metrics=Record<string,number|null>;
export interface SocialSnapshot {
 provider:'threads';username:string;name:string;rangeDays:7|30;since:string;until:string;
 account:Metrics;accountObservedAt:number|null;
 post:{id:string;text:string;permalink:string|null;postedAt:string|null;metrics:Metrics;observedAt:number|null}|null;
 replies:{id:string;text:string;username:string;at:string}[];repliesObservedAt:number|null;
 fetchedAt:number;refreshPending:boolean;
}
export const socialAdapter:DataAdapterManifest={schema:'producer.data-adapter/1',id:'threads',version:1,capability:'data.social@1',transport:'poll',operations:[{id:'dashboard',input:'social.selection@1',output:'social.dashboard@1',delivery:'snapshot',refresh:true}]};
export function parseSocialQuery(value:unknown):SocialQuery {
 if(value===undefined)return {};
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid social selection');
 const q=value as Record<string,unknown>;
 if(Object.keys(q).some(k=>!['postId','rangeDays'].includes(k))||q.postId!==undefined&&(typeof q.postId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q.postId))||q.rangeDays!==undefined&&q.rangeDays!==7&&q.rangeDays!==30)throw Error('Invalid social selection');
 return {...(q.postId?{postId:q.postId as string}:{}),...(q.rangeDays?{rangeDays:q.rangeDays as 7|30}:{})};
}
/** Workspace-only choices. These never belong in a portable presentation package. */
export function validModuleBindings(value:unknown):value is ModuleBindings {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>64)return false;
 return Object.entries(value).every(([role,b])=>{
  if(!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(role)||['constructor','prototype','__proto__'].includes(role)||!b||typeof b!=='object'||Object.keys(b).some(k=>!['id','revision','selection'].includes(k))||typeof b.id!=='string'||b.id.length>160||!Number.isSafeInteger(b.revision)||b.revision<1)return false;
  try{if(b.selection!==undefined)parseSocialQuery(b.selection);return true;}catch{return false;}
 });
}
const base=['username','name','period','status','error','accountUpdated','postUpdated','repliesUpdated','postText','postDate','postUrl','replyCount','fetchedAt'];
export const SOCIAL_FIELDS=[...base,...SOCIAL_METRICS.map(k=>'account_'+k),...POST_METRICS.map(k=>'post_'+k),...Array.from({length:6},(_,i)=>['reply'+i+'_name','reply'+i+'_text','reply'+i+'_at']).flat()];
export function socialState():Record<string,Field>{return Object.fromEntries(SOCIAL_FIELDS.map(k=>[k,{type:'text',default:k==='replyCount'?'0':k==='status'?'Connect your Threads account':k==='postText'?'Choose a post in Data connections':k.startsWith('account_')||k.startsWith('post_')?'—':'',maxLength:1024}]));}
const stamp=(at:number|null)=>at===null?'Not synced':new Date(at).toISOString();
const excerpt=(value:string,limit:number)=>{const normalized=value.replace(/\s+/g,' ');return normalized.length>limit?normalized.slice(0,limit-1)+'…':normalized;};
export function socialPayload(snapshot:SocialSnapshot):Record<string,string>{
 if(!snapshot||snapshot.provider!=='threads'||!Number.isFinite(snapshot.fetchedAt)||!Array.isArray(snapshot.replies)||snapshot.replies.length>6)throw Error('Invalid social snapshot');
 const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v.toLocaleString('en-US'):'—';
 const fields:Record<string,string>={username:'@'+snapshot.username,name:snapshot.name,period:`Last ${snapshot.rangeDays} days`,status:snapshot.refreshPending?'Refreshing metrics':'Connected · replies update automatically',error:'',accountUpdated:stamp(snapshot.accountObservedAt),postUpdated:stamp(snapshot.post?.observedAt??null),repliesUpdated:stamp(snapshot.repliesObservedAt),postText:snapshot.post?excerpt(snapshot.post.text,300):'Choose a post in Data connections',postDate:snapshot.post?.postedAt??'',postUrl:snapshot.post?.permalink??'',replyCount:String(snapshot.replies.length),fetchedAt:String(snapshot.fetchedAt)};
 for(const k of SOCIAL_METRICS)fields['account_'+k]=count(snapshot.account[k]);
 for(const k of POST_METRICS)fields['post_'+k]=count(snapshot.post?.metrics[k]);
 for(let i=0;i<6;i++){const r=snapshot.replies[i];fields['reply'+i+'_name']=r?'@'+r.username:'';fields['reply'+i+'_text']=excerpt(r?.text??'',110);fields['reply'+i+'_at']=r?.at??'';}
 return Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,1024)]));
}
