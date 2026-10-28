/** Public, bounded series snapshots. Chart layers never fetch URLs or retain an
 * unbounded stream; trusted adapters publish replacement snapshots. */
export interface ChartPoint {x:number;y:number|null}
export interface ChartData {scope:string;points:ChartPoint[]}
export interface ChartSpec {id:string;kind:'line'|'area'|'bar';data:ChartData;xMin:number;xMax:number;yMin:number;yMax:number;color:string;gridColor:string;durationMs:number;lineWidth:number;fillOpacity:number}
export function chartData(value:unknown):ChartData{
 if(typeof value!=='string'||value.length>32768)throw Error('Chart data must be bounded JSON text');
 const data=JSON.parse(value) as ChartData;
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['scope','points'].includes(k))||typeof data.scope!=='string'||new TextEncoder().encode(data.scope).length>120||data.scope.includes('\0')||!Array.isArray(data.points)||data.points.length>256)throw Error('Invalid chart series');
 const points=new Map<number,ChartPoint>();
 for(const p of data.points){if(!p||typeof p!=='object'||Object.keys(p).some(k=>!['x','y'].includes(k))||typeof p.x!=='number'||!Number.isFinite(p.x)||Math.abs(p.x)>1e15||p.y!==null&&(typeof p.y!=='number'||!Number.isFinite(p.y)||Math.abs(p.y)>1e6))throw Error('Invalid chart point');points.set(p.x,{x:p.x,y:p.y});}
 return {scope:data.scope,points:[...points.values()].sort((a,b)=>a.x-b.x)};
}
export function resolveChart(data:ChartData,spec:{id:string;kind:ChartSpec['kind'];color:string;gridColor?:string;durationMs?:number;lineWidth?:number;fillOpacity?:number;yMin?:number;yMax?:number;windowMs?:number}):ChartSpec{
 const xs=data.points.map(p=>p.x),ys=data.points.flatMap(p=>p.y===null?[]:[p.y]);
 const xMax=xs[xs.length-1]??1,xMin=spec.windowMs!==undefined?xMax-spec.windowMs:xs[0]??0;
 let lo=spec.yMin??(ys.length?Math.min(...ys):spec.yMax!==undefined?spec.yMax-1:0),hi=spec.yMax??(ys.length?Math.max(...ys):spec.yMin!==undefined?spec.yMin+1:1);
 if(!Number.isFinite(lo))lo=0;if(!Number.isFinite(hi))hi=1;
 const pad=Math.max(1,(hi-lo)*.12);if(spec.yMin===undefined)lo-=pad;if(spec.yMax===undefined)hi+=pad;
 if(hi<=lo)throw Error('Chart vertical range must increase');
 return {id:spec.id,kind:spec.kind,data,xMin:xMin===xMax?xMax-1:xMin,xMax,yMin:lo,yMax:hi,color:spec.color,gridColor:spec.gridColor??'#a9c4df22',durationMs:spec.durationMs??650,lineWidth:spec.lineWidth??3,fillOpacity:spec.fillOpacity??.16};
}
/** Adapter helper for genuine append feeds. Explicit generations fence old
 * connections/cities; revisions fence duplicate and out-of-order deliveries. */
export class ChartSeriesWindow{
 private generation=-1;private revision=-1;private data:ChartData={scope:'',points:[]};
 constructor(private maxPoints=256){if(!Number.isInteger(maxPoints)||maxPoints<2||maxPoints>256)throw Error('Invalid chart history limit');}
 push(update:{generation:number;revision:number;scope:string;points:ChartPoint[];mode:'append'|'replace'}):ChartData{
  if(!Number.isSafeInteger(update.generation)||update.generation<0||!Number.isSafeInteger(update.revision)||update.revision<0||!['append','replace'].includes(update.mode))throw Error('Invalid series revision');
  const input=chartData(JSON.stringify({scope:update.scope,points:update.points}));
  if(update.generation<this.generation||update.generation===this.generation&&(update.revision<=this.revision||update.scope!==this.data.scope))return this.snapshot();
  const reset=update.generation>this.generation||update.mode==='replace';
  const merged=new Map((reset?[]:this.data.points).map(p=>[p.x,p]));for(const p of input.points)merged.set(p.x,p);
  this.data={scope:input.scope,points:[...merged.values()].sort((a,b)=>a.x-b.x).slice(-this.maxPoints)};this.generation=update.generation;this.revision=update.revision;return this.snapshot();
 }
 snapshot():ChartData{return structuredClone(this.data);}
}
