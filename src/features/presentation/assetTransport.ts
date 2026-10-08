import type {OutputProjection} from './projection';
/** Each canvas lease has its own acknowledged media cache. Asset bytes are sent
 * once, then referenced by ID. A content replacement invalidates that ID. */
export class AssetTransport {
 private sent=new Map<string,import('./assets').MediaAsset>();private versions=new Map<string,number>();private next=0;
 clear(){this.sent.clear();this.versions.clear();this.next=0;}
 signature(p:OutputProjection){
  const assets=Object.fromEntries(Object.entries(p.assets??{}).map(([id,a])=>{let version=this.versions.get(a.data);if(version===undefined){version=++this.next;this.versions.set(a.data,version);}return[id,{name:a.name,mime:a.mime,version}];}));
  return {...p,revision:0,assets};
 }
 compact(p:OutputProjection):OutputProjection{return {...p,assets:Object.fromEntries(Object.entries(p.assets??{}).filter(([id,a])=>this.sent.get(id)?.data!==a.data||this.sent.get(id)?.name!==a.name||this.sent.get(id)?.mime!==a.mime))};}
 acknowledge(p:OutputProjection){for(const[id,a]of Object.entries(p.assets??{}))this.sent.set(id,a);}
}
