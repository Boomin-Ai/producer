// Bounded image-only DJ preset. No SVG, script, remote URL or renderer code.
export function parseLogoOrbit(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['title','subtitle','ink','seconds','logos'].includes(k)))throw Error('Invalid logo orbit');
 for(const k of ['title','subtitle'])if(typeof v[k]!=='string'||!v[k].trim()||!/^[\x20-\x7e]{1,32}$/.test(v[k]))throw Error('Invalid orbit title');
 if(!/^#[\da-f]{6}$/i.test(v.ink)||!Number.isFinite(v.seconds)||v.seconds<6||v.seconds>60||!Array.isArray(v.logos)||v.logos.length<1||v.logos.length>16)throw Error('Invalid orbit controls');
 const ids=new Set();for(const l of v.logos){
  if(!l||Object.keys(l).some(k=>!['id','data','band'].includes(k))||typeof l.id!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(l.id)||['constructor','prototype'].includes(l.id)||ids.has(l.id)||!Number.isInteger(l.band)||l.band<0||l.band>7)throw Error('Invalid orbit logo');ids.add(l.id);
  if(typeof l.data!=='string'||l.data.length>131094||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(l.data))throw Error('Orbit logos must be small embedded PNGs');
  let bytes;const encoded=l.data.slice(22);try{if(encoded.length%4!==0)throw Error();bytes=atob(encoded);if(btoa(bytes)!==encoded)throw Error();}catch{throw Error('Invalid orbit PNG');}
  if(bytes.length<24||bytes.length>98304||[137,80,78,71,13,10,26,10].some((n,i)=>bytes.charCodeAt(i)!==n)||bytes.slice(12,16)!=='IHDR')throw Error('Invalid orbit PNG');
  const u32=i=>((bytes.charCodeAt(i)*16777216)+(bytes.charCodeAt(i+1)<<16)+(bytes.charCodeAt(i+2)<<8)+bytes.charCodeAt(i+3));
  if(u32(16)<1||u32(20)<1||u32(16)>512||u32(20)>512)throw Error('Orbit logo dimensions exceeded');
 }return structuredClone(v);
}
const color={type:'string',pattern:'^#[0-9a-fA-F]{6}$'};
export const LOGO_ORBIT_SCHEMA={type:'object',additionalProperties:false,required:['title','subtitle','ink','seconds','logos'],properties:{title:{type:'string',minLength:1,maxLength:32},subtitle:{type:'string',minLength:1,maxLength:32},ink:color,seconds:{type:'number',minimum:6,maximum:60},logos:{type:'array',minItems:1,maxItems:16,items:{type:'object',additionalProperties:false,required:['id','data','band'],properties:{id:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'},data:{type:'string',maxLength:131094,pattern:'^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$'},band:{type:'integer',minimum:0,maximum:7}}}}}};
const curves=new Map();
function curve(width,height){
 const key=width+':'+height;if(curves.has(key))return curves.get(key);
 const points=[],rx=width*.425,ry=height*(width/height>4?.37:.34);let distance=0;
 for(let i=0;i<=1024;i++){const a=i/1024*Math.PI*2,c=Math.cos(a),s=Math.sin(a),p={x:rx*Math.sign(c)*Math.abs(c)**.42,y:ry*Math.sign(s)*Math.abs(s)**.42};if(i)distance+=Math.hypot(p.x-points[i-1].x,p.y-points[i-1].y);points.push({...p,distance});}
 const result={points,distance,rx,ry};if(curves.size>=8)curves.delete(curves.keys().next().value);curves.set(key,result);return result;
}
/** Music contribution is zero on silence. Orbit time is independent of beats. */
export function logoPlacement({width,height,count,index,seconds,time,level=0,wave=0,response=1}){
 const wide=width/height>4;const base=Math.min(width*.059,height*(wide?.11:.12));
 const path=curve(width,height),phase=((index/count+time/seconds-.25)%1+1)%1,at=phase*path.distance;
 let lo=0,hi=path.points.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(path.points[mid].distance<at)lo=mid;else hi=mid;}
 const a=path.points[lo],b=path.points[hi],f=(at-a.distance)/(b.distance-a.distance),ox=a.x+(b.x-a.x)*f,oy=a.y+(b.y-a.y)*f;
 const strength=Math.min(1,Math.max(0,level))*Math.min(2,Math.max(0,response));
 const size=Math.min(height*.16,base*(1+strength*.35)),half=size/2,outward=Math.min(1,Math.abs(wave))*height*.02*strength;
 let x=Math.max(half,Math.min(width-half,width/2+ox*(1+strength*width*.008/path.rx))),y=Math.max(half,Math.min(height-half,height/2+oy*(1+outward/path.ry)));
 // Protect the stationary title even at maximum music response.
 const left=width*.17,right=width*.83,top=height*(wide?.23:.24),bottom=height*(wide?.75:.71);
 if(x+half>left&&x-half<right&&y+half>top&&y-half<bottom){
  const choices=[{x:left-half,y},{x:right+half,y},{x,y:top-half},{x,y:bottom+half}].filter(p=>p.x>=half&&p.x<=width-half&&p.y>=half&&p.y<=height-half);
  choices.sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y));if(choices[0])({x,y}=choices[0]);
 }
 return {x,y,size,strength};
}
