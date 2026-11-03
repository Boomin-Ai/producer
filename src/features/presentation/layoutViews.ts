import type {PresentationPackage} from './schema';
export type LayoutOrientation='landscape'|'portrait'|'square';
type SetDesign=PresentationPackage['set'];
export type LayoutView={id:string;label:string;variants:Partial<Record<LayoutOrientation,string>>};
export const layoutOrientation=(layout:{width:number;height:number}):LayoutOrientation=>layout.width>layout.height?'landscape':layout.height>layout.width?'portrait':'square';
const cleanLabel=(label:string)=>label.replace(/\s*[·—–-]\s*(Landscape|Portrait|Square)$/i,'');
/** Explicit identities win. Suffix pairing is only a legacy import fallback. */
export function layoutViews(set:SetDesign):LayoutView[]{
 const result:LayoutView[]=[],used=new Set<string>();
 for(const [id,variants]of Object.entries(set.views??{})){
  const entries=Object.entries(variants).filter(([,key])=>set.layouts.some(l=>l.id===key));
  if(!entries.length)continue;
  const layout=set.layouts.find(l=>l.id===(variants.landscape??entries[0][1]))!;
  result.push({id,label:cleanLabel(layout.label),variants:Object.fromEntries(entries)});
  entries.forEach(([,key])=>used.add(key!));
 }
 for(const layout of set.layouts){
  if(used.has(layout.id))continue;
  const variants:LayoutView['variants']={[layoutOrientation(layout)]:layout.id};
  const match=layout.id.match(/^(.*)-(landscape|portrait|square)$/);
  if(match)for(const orientation of ['landscape','portrait','square'] as const){
   const other=set.layouts.find(l=>l.id===match[1]+'-'+orientation&&!used.has(l.id)&&layoutOrientation(l)===orientation);
   if(other)variants[orientation]=other.id;
  }
  result.push({id:'layout:'+layout.id,label:cleanLabel(layout.label),variants});Object.values(variants).forEach(id=>used.add(id));
 }
 return result;
}
export function viewForLayout(set:SetDesign,id:string){return layoutViews(set).find(v=>Object.values(v.variants).includes(id));}
export function outputLayout(set:SetDesign,id:string,orientation:LayoutOrientation):string{
 return viewForLayout(set,id)?.variants[orientation]??id;
}
export function preferredViewLayout(view:LayoutView){return view.variants.landscape??view.variants.portrait??view.variants.square!;}
