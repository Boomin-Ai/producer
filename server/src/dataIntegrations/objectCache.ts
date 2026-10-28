/** Bounded data objects; reads never extend freshness. Stored beside a saved
 * connection, so credentials and connection revisions remain the authority. */
export interface CacheEntry<T> {key:string;fetchedAt:number;value:T}
export interface CachePolicy {freshMs:number;staleMs:number;maxEntries:number;maxBytes:number}
interface Stored<T> {schema:'producer.data-cache/1';entries:CacheEntry<T>[]}
export function readObjects<T>(raw:string|null,legacyAt:number|null):CacheEntry<T>[] {
 if(!raw)return [];
 try{const value=JSON.parse(raw);if(value.schema==='producer.data-cache/1'&&Array.isArray(value.entries))return value.entries.filter((e:CacheEntry<T>)=>typeof e.key==='string'&&Number.isSafeInteger(e.fetchedAt)&&e.fetchedAt>=0&&e.value).slice(-32);
 // Older servers stored one weather object. Preserve its original fetch time.
 if(typeof value.requestKey==='string'&&legacyAt)return [{key:value.requestKey,fetchedAt:legacyAt,value}];
 }catch{}return [];
}
export function cachedObject<T>(entries:CacheEntry<T>[],key:string,policy:CachePolicy,now:number){
 const entry=entries.find(e=>e.key===key);if(!entry||entry.fetchedAt>now||now-entry.fetchedAt>policy.freshMs+policy.staleMs)return;
 return {...entry,stale:now-entry.fetchedAt>=policy.freshMs,expiresAt:entry.fetchedAt+policy.freshMs};
}
export function writeObjects<T>(entries:CacheEntry<T>[],entry:CacheEntry<T>,policy:CachePolicy,now:number):string{
 const kept=[...entries.filter(e=>e.key!==entry.key&&e.fetchedAt<=now&&now-e.fetchedAt<=policy.freshMs+policy.staleMs),entry].sort((a,b)=>a.fetchedAt-b.fetchedAt).slice(-policy.maxEntries);
 const encode=()=>JSON.stringify({schema:'producer.data-cache/1',entries:kept} satisfies Stored<T>);
 while(kept.length>1&&new TextEncoder().encode(encode()).byteLength>policy.maxBytes)kept.shift();
 const raw=encode();if(new TextEncoder().encode(raw).byteLength>policy.maxBytes)throw Error('Data object exceeds cache budget');return raw;
}
