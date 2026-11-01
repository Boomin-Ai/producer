import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const repository = fileURLToPath(new URL('../..', import.meta.url));
let runtime;
export function authoringRuntime() {
  return runtime ??= build({
    absWorkingDir:repository,
    stdin:{resolveDir:repository,contents:`
      export * from './src/features/presentation/authoring/catalog';
      export * from './src/features/presentation/authoring/compiler';
      export * from './src/features/presentation/authoring/brief';
      export * from './src/features/presentation/authoring/visual';
      export * from './src/features/presentation/validation';
      export {presentationJsonSchema} from './src/features/presentation/schema';`},
    bundle:true,platform:'node',format:'esm',write:false,
  }).then(result=>import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64')));
}

let previewBundle;
async function previewScript() {
  return previewBundle ??= build({
    absWorkingDir:repository,
    stdin:{resolveDir:repository,loader:'tsx',contents:`
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {SetPreview} from './src/features/presentation/SetPreview';
      import {RehearsalSession} from './src/features/presentation/rehearsal';
      import {parsePackage} from './src/features/presentation/schema';
      import {auditVisuals} from './src/features/presentation/authoring/visualBrowser';
      const doc=parsePackage(JSON.parse(document.getElementById('package').textContent));
      const session=new RehearsalSession(doc,undefined,'prepare');
      const root=createRoot(document.getElementById('preview'));
      function render(){const state=session.snapshot();const layout=doc.set.layouts.find(l=>l.id===state.layoutId);document.getElementById('preview').style.width='min(100%, '+(82*layout.width/layout.height)+'vh)';root.render(<SetPreview doc={doc} state={state}/>);}
      const select=document.getElementById('layouts');
      for(const l of doc.set.layouts){const o=document.createElement('option');o.value=l.id;o.textContent=l.label;select.append(o);}
      select.value=doc.set.initialLayout;
      select.onchange=()=>{session.send({type:'control',action:{type:'layout.select',layoutId:select.value}});render();};
      render();
      auditVisuals(doc).then(report=>{
        window.__producerVisualReview={ok:true,report};
        const region=document.getElementById('review');region.textContent='Visual review: '+(report.issues.length?report.issues.length+' findings':'configured text fits; no supported geometry issues found');
        for(const issue of report.issues){const p=document.createElement('p');p.textContent=issue.layout+' / '+issue.node+': '+issue.message;region.append(p);}
      }).catch(error=>{window.__producerVisualReview={ok:false,error:error.message};document.getElementById('review').textContent='Visual review unavailable: '+error.message;});`},
    bundle:true,platform:'browser',format:'iife',write:false,minify:true,
    define:{'process.env.NODE_ENV':'"production"'},
    plugins:[{name:'producer-raw',setup(b){
      b.onLoad({filter:/\?raw$/},async args=>({contents:await readFile(args.path.slice(0,-4),'utf8'),loader:'text'}));
      b.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path)}));
    }}],
  }).then(result=>result.outputFiles[0].text);
}

export async function previewHtml(doc) {
  const code=(await previewScript()).replaceAll('</script','<\\/script');
  const data=JSON.stringify(doc).replaceAll('<','\\u003c');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Producer Set preview</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{margin:24px;background:#10141c;color:#eee;font:16px system-ui}header{display:flex;gap:20px;align-items:center;margin-bottom:16px}select{font:inherit;padding:8px}#preview{max-width:1100px;margin:auto}.set-preview{position:relative;width:100%;max-height:85vh}.set-preview iframe{position:absolute;border:0;width:100%;height:100%}.set-preview-status{position:absolute;bottom:8px;left:8px;background:#10141c;padding:8px}p{color:#b9c3d2}</style>
  <header><strong>Producer · Draft preview</strong><label>Layout <select id="layouts"></select></label></header>
  <p>Browser preview only. Cameras are placeholders; audio-reactive effects use simulated levels. Import the Set into Producer to bind sources and check native output.</p>
  <div id="preview"></div><section id="review" aria-label="Visual review">Checking every layout…</section><script id="package" type="application/json">${data}</script><script>${code}</script></html>`;
}
