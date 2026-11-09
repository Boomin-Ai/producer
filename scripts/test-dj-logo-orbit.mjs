import assert from 'node:assert/strict';
import {parseWorld} from '../src/features/presentation/scene3d/contract.mjs';
import {parseLogoOrbit,logoPlacement} from '../src/features/presentation/scene3d/logoOrbit.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDaMAAAAASUVORK5CYII=';
const orbit={title:'360 DEAL',subtitle:'THE NEW',ink:'#171720',seconds:18,logos:[{id:'twitch',data:png,band:0}]};
assert.deepEqual(parseLogoOrbit(orbit),orbit);
for(const edit of [v=>v.logos[0].data='https://example.com/logo.png',v=>v.logos[0].data='data:image/svg+xml;base64,PHN2Zy8+',v=>v.logos[0].band=8,v=>v.logos.push({...v.logos[0]}),v=>v.seconds=0,v=>v.title='x'.repeat(33),v=>v.logos[0].id='constructor',v=>delete v.logos[0].id,v=>v.logos[0].id=null,v=>v.script='alert(1)']){const v=structuredClone(orbit);edit(v);assert.throws(()=>parseLogoOrbit(v));}
const world={schema:'producer.scene3d/1',fps:30,clearColor:'#fff8ed',fog:{color:'#fff8ed',near:10,far:100},camera:{position:[0,0,10],target:[0,0,0],fov:45},objects:[],slots:[],dj:{role:'logoOrbit',logoOrbit:orbit}};
assert.deepEqual(parseWorld(world),world);const wrongRole=structuredClone(world);wrongRole.dj.role='stage';assert.throws(()=>parseWorld(wrongRole));
for(const [width,height]of [[1500,530],[1500,320],[807,287],[425,151]])for(let index=0;index<13;index++)for(let time=0;time<18;time+=.25){
 const input={width,height,count:13,index,seconds:18,time};const silent=logoPlacement(input),beat=logoPlacement({...input,level:1,wave:1,response:2});assert.ok(beat.size>silent.size);assert.ok(beat.x-beat.size/2>=-.001&&beat.y-beat.size/2>=-.001);assert.ok(beat.x+beat.size/2<=width+.001&&beat.y+beat.size/2<=height+.001);assert.deepEqual(logoPlacement({...input,level:1,response:0}),silent);
 const wide=width/height>4,left=width*.17,right=width*.83,top=height*(wide?.23:.24),bottom=height*(wide?.75:.71),half=beat.size/2;assert.ok(beat.x+half<=left+.001||beat.x-half>=right-.001||beat.y+half<=top+.001||beat.y-half>=bottom-.001,'Logo overlaps title');
}
for(const [width,height]of [[1100,390],[1500,320]]){let previous;for(let t=0;t<18;t+=1/60){const p=logoPlacement({width,height,count:13,index:0,seconds:18,time:t,level:1,wave:1,response:2});if(previous)assert.ok(Math.hypot(p.x-previous.x,p.y-previous.y)<width*.01,'Orbit has a visible corner jump');previous=p;}}
console.log('PASS: embedded image bounds, native world role, per-logo music transforms, silence/off behavior and orbit containment.');
const {build}=await import('esbuild');const bundle=await build({stdin:{resolveDir:process.cwd(),contents:"export {packageFeatures} from './src/features/presentation/authoring/features';export {AUTHORING_CATALOG,requireFeatures} from './src/features/presentation/authoring/catalog';"},bundle:true,format:'esm',platform:'node',write:false});
const {packageFeatures,AUTHORING_CATALOG,requireFeatures}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const required=packageFeatures({runtime:{instances:[],definitions:{}},set:{layouts:[{root:{type:'scene3d',scene3d:{world}}}],components:{}}});assert.ok(required.includes('dj.logo-orbit@1'));assert.ok(AUTHORING_CATALOG.features.includes('dj.logo-orbit@1'));assert.throws(()=>requireFeatures({catalogRevision:AUTHORING_CATALOG.revision,features:['core@1','scene3d@1']},required));
console.log('PASS: MCP authoring advertises the new capability and refuses targets without it.');
