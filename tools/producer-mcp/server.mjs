import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {constants} from 'node:fs';
import {mkdir,realpath,readdir,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {authoringRuntime,previewHtml} from './runtime.mjs';

const MAX_PACKAGE=40*1024*1024, MAX_DESIGN=128*1024;
const fileName=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.set\.json$/);
const document=z.record(z.unknown());
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

/** File authoring only. No workspace credentials, room writes or native device access. */
export async function createAuthoringServer(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const root=await realpath(directory),api=await authoringRuntime();
  const target={catalogRevision:api.AUTHORING_CATALOG.revision,features:[...api.AUTHORING_CATALOG.features]};
  const scope={validation:'package-structure',nativeReadiness:'not-tested',outputChanged:false};
  const server=new McpServer({name:'producer-sets',version:'0.1.0'});

  async function read(file) {
    fileName.parse(file);
    const handle=await open(join(root,file),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const stat=await handle.stat();
      if(!stat.isFile()||stat.size>MAX_PACKAGE)throw Error('Set must be a regular file of at most 40 MB.');
      const chunks=[];let bytes=0;
      for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:65536})){
        bytes+=chunk.length;if(bytes>MAX_PACKAGE)throw Error('Set exceeds 40 MB.');chunks.push(chunk);
      }
      return api.parsePackageText(Buffer.concat(chunks).toString('utf8'));
    } finally {await handle.close();}
  }
  function checkDesign(value) {
    if(Buffer.byteLength(JSON.stringify(value))>MAX_DESIGN)throw Error('Design input exceeds 128 KB.');
  }
  async function writeNew(name,contents) {
    const file=join(root,name),handle=await open(file,'wx',0o600);
    try{await handle.writeFile(contents);await handle.sync();}
    catch(error){await handle.close();await unlink(file).catch(()=>{});throw error;}
    await handle.close();return file;
  }
  async function save(doc) {
    const text=JSON.stringify(doc,null,2);
    api.parsePackageText(text);
    const file=`${doc.id}-${randomUUID()}.set.json`;
    const path=await writeNew(file,text);
    return {file,path,revision:await api.packageRevision(doc),layouts:doc.set.layouts.map(l=>({id:l.id,name:l.label,width:l.width,height:l.height})),...scope};
  }
  function tool(name,description,inputSchema,readOnly,fn) {
    server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly,openWorldHint:false}},async input=>{
      try{return reply(await fn(input));}
      catch(error){
        // Do not echo arbitrary file contents or user-supplied media in diagnostics.
        const message=error?.code==='ENOENT'?'Set file was not found in the configured directory.':error?.code==='ELOOP'?'Symbolic links are not accepted.':String(error?.message??'Authoring failed.').slice(0,1600);
        return {isError:true,content:[{type:'text',text:message}]};
      }
    });
  }
  tool('producer_capabilities','Discover the local compiler profile, plan/edit instructions and validation limits. This is not a connected native renderer capability probe.',{},true,async()=>({catalog:api.AUTHORING_CATALOG,target,instructions:api.DESIGN_INSTRUCTIONS,directory:root,...scope}));
  tool('producer_list_sets','List Set packages in the configured authoring directory.',{},true,async()=>({files:(await readdir(root,{withFileTypes:true})).filter(f=>f.isFile()&&fileName.safeParse(f.name).success).map(f=>f.name).sort().slice(0,200)}));
  tool('producer_inspect_set','Read an existing Set tree and revision with asset bytes removed. Use its stable IDs for edits.',{file:fileName},true,async({file})=>{const doc=await read(file);const context=api.designContext(doc);if(Buffer.byteLength(JSON.stringify(context))>256*1024)throw Error('Set context exceeds 256 KB; use the local file workflow.');return {revision:await api.packageRevision(doc),context,...scope};});
  tool('producer_compile_set','Compile a compact design plan to a new validated .set.json file. Optional assetsFrom supplies existing authorized asset IDs; embedded assets never enter the tool response.',{plan:document,assetsFrom:fileName.optional()},false,async({plan,assetsFrom})=>{checkDesign(plan);const assets=assetsFrom?(await read(assetsFrom)).set.assets:{};return save(api.compileDesignPlan(plan,target,assets));});
  tool('producer_edit_set','Apply atomic revision-fenced edits and save a new draft. The original file stays intact. Inspect the current revision first.',{file:fileName,edit:document},false,async({file,edit})=>{
    checkDesign(edit);const base=await read(file),revision=await api.packageRevision(base);
    const next=await api.applyDesignEdits(base,edit,target);
    if(await api.packageRevision(await read(file))!==revision)throw Error('The source Set changed during this edit. Inspect it again.');
    return save(next);
  });
  tool('producer_validate_set','Validate the full canonical Set schema, including features beyond compact plans. Structural validity does not establish native readiness.',{file:fileName},true,async({file})=>{const doc=await read(file);return {ok:true,id:doc.id,revision:await api.packageRevision(doc),layouts:doc.set.layouts.length,...scope};});
  tool('producer_preview_set','Create a standalone HTML browser preview using Producer’s actual SetPreview renderer. Cameras are placeholders and audio is simulated. Does not load preparation or put anything on air.',{file:fileName},false,async({file})=>{
    const doc=await read(file);
    const name=`preview-${randomUUID()}.html`,path=await writeNew(name,await previewHtml(doc));
    return {path,packageFile:file,revision:await api.packageRevision(doc),preview:'browser-simulation',...scope};
  });
  server.registerResource('authoring-guide','producer://authoring/guide',{mimeType:'application/json',description:'Producer compiler capabilities and compact plan/edit contract'},async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify({catalog:api.AUTHORING_CATALOG,instructions:api.DESIGN_INSTRUCTIONS,...scope})}]}));
  server.registerResource('canonical-schema','producer://authoring/schema',{mimeType:'application/schema+json',description:'Full canonical Set JSON schema from the installed checkout; broader than compact plans. Load only for advanced file authoring.'},async uri=>({contents:[{uri:uri.href,mimeType:'application/schema+json',text:JSON.stringify(api.presentationJsonSchema)}]}));
  return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=process.env.PRODUCER_SETS_DIR??join(homedir(),'Documents','Producer Sets');
  const server=await createAuthoringServer(directory);
  await server.connect(new StdioServerTransport());
}
