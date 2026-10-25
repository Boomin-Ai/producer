import {build} from 'esbuild';
import {writeFile} from 'node:fs/promises';
const bundle=await build({stdin:{contents:"export {runtimeJsonSchema} from './shared/set-runtime/jsonSchema';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {runtimeJsonSchema}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
await writeFile('docs/set-runtime/modules.schema.json',JSON.stringify(runtimeJsonSchema,null,2)+'\n');
console.log('docs/set-runtime/modules.schema.json');
