import assert from 'node:assert/strict';
import {build} from 'esbuild';
process.on('uncaughtException',error=>{console.error(error.message);process.exit(1);});
const bundle=await build({stdin:{contents:"export * from './src/features/presentation/controlArrangements';export {parsePackage,presentationJsonSchema} from './src/features/presentation/schema';export {moduleTemplate,moduleInstance} from './shared/set-runtime/templates';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {arrangementCatalog,createArrangementPreferences,reconcileArrangementPreferences,resolveArrangement,parsePackage,presentationJsonSchema,moduleTemplate,moduleInstance}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const source={schema:'producer.presentation/2',id:'sample',version:'1',name:'Sample',set:{initialLayout:'main',values:{title:{type:'text',default:'Hello',maxLength:80}},feeds:{},slots:[],components:{},layouts:[{id:'main',label:'Main',width:1280,height:720,root:{id:'root',type:'box',children:[]}}],controls:[{id:'title',type:'text',label:'Title',key:'title'},{id:'layout',type:'button',label:'Main',action:{type:'layout.select',layoutId:'main'}}]},runtime:{schema:'producer.modules/1',definitions:{weather:moduleTemplate('weather')},instances:[moduleInstance('weather','weather')]}};
let doc=parsePackage(source),catalog=arrangementCatalog(doc);
assert.deepEqual(resolveArrangement(catalog).minimized,[],'No inferred minimized placements');
assert(catalog.controls.some(c=>c.id==='module:weather:$weather-location'));
assert(catalog.controls.some(c=>c.id==='builtin:layout'));
source.set.controlArrangement={sections:[{id:'weather',label:'Weather desk',controls:['module:weather:$weather-location','set:title'],collapsed:true}],minimized:['set:title','builtin:layout']};
doc=parsePackage(source);catalog=arrangementCatalog(doc);
assert.deepEqual(resolveArrangement(catalog).minimized,['set:title','builtin:layout']);
assert.equal(resolveArrangement(catalog).sections[0].collapsed,true);
const prefs=createArrangementPreferences(catalog);
prefs.minimized['set:title']=false;prefs.minimized['module:weather:$weather-location']=true;
prefs.minimizedOrder=['module:weather:$weather-location','builtin:layout'];
prefs.sectionOrder=[catalog.sections.at(-1).id,catalog.sections[0].id];
prefs.controlOrder['authored:weather']=['set:title','module:weather:$weather-location'];
prefs.collapsed['authored:weather']=false;
const resolved=resolveArrangement(catalog,JSON.parse(JSON.stringify(prefs)));
assert.deepEqual(resolved.minimized,['module:weather:$weather-location','builtin:layout']);
assert.equal(resolved.sections[0].id,catalog.sections.at(-1).id);
assert.deepEqual(resolved.sections.find(s=>s.id==='authored:weather').controls,['set:title','module:weather:$weather-location']);
assert.equal(resolved.sections.find(s=>s.id==='authored:weather').collapsed,false);
assert.equal(doc.set.controlArrangement.sections[0].collapsed,true,'Preferences never mutate author defaults');
const independent=structuredClone(prefs);independent.minimizedOrder.reverse();
assert.deepEqual(resolveArrangement(catalog,independent).sections,resolved.sections);
assert.deepEqual(resolveArrangement(catalog,createArrangementPreferences(catalog)).minimized,['set:title','builtin:layout'],'Reset restores author defaults');
const compatible=structuredClone(doc);compatible.version='2';compatible.set.controls[0].label='Renamed';
assert.deepEqual(resolveArrangement(arrangementCatalog(compatible),prefs),resolved,'Compatible rename/update preserves preferences');
const changed=structuredClone(doc);changed.set.controls[0]={id:'title',type:'button',label:'Title',action:{type:'layout.select',layoutId:'main'}};
assert.equal(reconcileArrangementPreferences(arrangementCatalog(changed),prefs).minimized['set:title'],undefined,'Incompatible control loses override');
const removed=structuredClone(doc);removed.set.controls.shift();delete removed.set.controlArrangement;
const cleaned=reconcileArrangementPreferences(arrangementCatalog(removed),prefs);
assert(!Object.hasOwn(cleaned.signatures,'set:title'));assert(!Object.hasOwn(cleaned.minimized,'set:title'));
for(const bad of [null,[],{version:9},{version:1,signatures:{},minimized:{'set:title':true},minimizedOrder:['ghost']}])assert.deepEqual(resolveArrangement(catalog,bad),resolveArrangement(catalog));
for(const arrangement of [
 {sections:[],minimized:['set:missing']},
 {sections:[],minimized:['set:title','set:title']},
 {sections:[{id:'a',label:'A',controls:['set:title']},{id:'a',label:'B',controls:[]}],minimized:[]},
 {sections:[{id:'a',label:'A',controls:['set:title']},{id:'b',label:'B',controls:['set:title']}],minimized:[]},
 {sections:[],minimized:['module:weather:$behavior-tools']},
 {sections:[],minimized:[],unknown:true},
])assert.throws(()=>parsePackage({...source,set:{...source.set,controlArrangement:arrangement}}));
assert.equal(presentationJsonSchema.properties.set.properties.controlArrangement.additionalProperties,false);
assert.equal(presentationJsonSchema.properties.set.properties.controlArrangement.properties.minimized.maxItems,64);
console.log('PASS: explicit placement, independent surfaces, saved preferences, upgrades, reset, strict references and schema bounds');
