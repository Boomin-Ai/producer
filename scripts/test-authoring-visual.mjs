import assert from 'node:assert/strict';
import {authoringRuntime} from '../tools/producer-mcp/runtime.mjs';
import {checkRenderedSet} from '../tools/producer-mcp/visual-check.mjs';
const api=await authoringRuntime(),target={catalogRevision:2,features:[...api.AUTHORING_CATALOG.features]};
const plan={schema:'producer.design-plan/1',id:'visual-proof',name:'Visual proof',background:'#f4ecd8',layouts:['landscape','portrait'].map(orientation=>({id:orientation,name:orientation,orientation,elements:[
 {id:'ring',kind:'effect',bounds:[90,200,600,600],effect:'voiceRing',radius:300},
 {id:'host',kind:'camera',bounds:[200,300,400,400],slot:'host',radius:200},
 {id:'title',kind:'text',bounds:[40,40,950,100],text:'ATTENTION IS CURRENCY',color:'#000000',size:48},
]}))};
const original=api.compileDesignPlan(plan,target),before=JSON.stringify(original);
assert.equal(api.checkVisualGeometry(original).issues.filter(i=>i.code==='ring_center').length,2);
let fixed=original;
for(const layout of original.set.layouts)fixed=await api.repairCameraRing(fixed,{layout:layout.id,ring:'ring',camera:'host',baseRevision:await api.packageRevision(fixed)});
assert.equal(JSON.stringify(original),before);assert.deepEqual(api.checkVisualGeometry(fixed).issues,[]);
assert.deepEqual(fixed.set.controls,original.set.controls);assert.deepEqual(fixed.set.slots,original.set.slots);
await assert.rejects(api.repairCameraRing(fixed,{layout:'landscape',ring:'ring',camera:'host',baseRevision:await api.packageRevision(original)}),/changed/);
const edge=structuredClone(original);edge.set.layouts[0].root.children[1].styles.left=0;const frozen=JSON.stringify(edge);
await assert.rejects(api.repairCameraRing(edge,{layout:'landscape',ring:'ring',camera:'host',baseRevision:await api.packageRevision(edge)}),/not enough canvas/);assert.equal(JSON.stringify(edge),frozen);
const ambiguous=structuredClone(original),clone=structuredClone(ambiguous.set.layouts[0].root.children[1]);clone.id='second';ambiguous.set.layouts[0].root.children.push(clone);
assert(api.checkVisualGeometry(ambiguous).issues.some(i=>i.code==='ring_association'&&!i.repair));
const clean=await checkRenderedSet(fixed);assert.equal(clean.textChecked,true);assert.deepEqual(clean.issues,[]);
const multiline=structuredClone(plan);
for(const layout of multiline.layouts){const title=layout.elements.find(n=>n.id==='title');title.text='LINE ONE\nLINE TWO';title.bounds=[40,40,950,80];}
const multilineReport=await checkRenderedSet(api.compileDesignPlan(multiline,target));
assert.equal(multilineReport.issues.filter(i=>i.code==='text_fit'&&i.node==='title').length,2,'Explicit line breaks must be measured as two lines, matching native output');
const overflow=structuredClone(fixed);for(const layout of overflow.set.layouts){const text=layout.root.children.find(n=>n.id==='title');text.styles.width=160;text.styles.height=40;text.styles.fontSize=70;}
const report=await checkRenderedSet(overflow);assert.equal(report.issues.filter(i=>i.code==='text_fit').length,2,'Both orientations measure clipped glyphs');
assert(report.issues.filter(i=>i.code==='text_fit').every(i=>i.node==='title'&&i.measurements.contentHeight>i.measurements.height&&i.path==='output/root/title'));
const overlap=structuredClone(fixed),title=structuredClone(overlap.set.layouts[0].root.children.find(n=>n.id==='title'));title.id='overlap';overlap.set.layouts[0].root.children.push(title);
assert(api.checkVisualGeometry(overlap).issues.some(i=>i.code==='text_overlap'&&i.severity==='warning'));
console.log('PASS: actual renderer text-fit in both formats, targeted ring repair, stale/conflicting/edge geometry refusal, original/control preservation and advisory overlap checks.');
