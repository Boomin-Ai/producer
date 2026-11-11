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
import {checkRenderedSet} from './visual-check.mjs';
import {publishPackage,listPublications,publishingRequest} from './publication.mjs';
import {renderPublicationPreview} from './publication-preview.mjs';

const MAX_PACKAGE=40*1024*1024, MAX_DESIGN=1024*1024;
const fileName=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}\.set\.json$/);
const document=z.record(z.unknown());
const reply=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

/** File authoring by default. Publishing is explicit opt-in; never touches devices or output. */
export async function createAuthoringServer(directory) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const root=await realpath(directory),api=await authoringRuntime();
  const target={catalogRevision:api.AUTHORING_CATALOG.revision,features:[...api.AUTHORING_CATALOG.features]};
  const scope={validation:'package-structure',nativeReadiness:'not-tested',outputChanged:false};
  const publishing=process.env.PRODUCER_ENABLE_PUBLISH==='1';
  const server=new McpServer({name:'producer-sets',version:'0.3.0'});

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
    if(Buffer.byteLength(JSON.stringify(value))>MAX_DESIGN)throw Error('Design input exceeds 1 MB.');
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
    return {file,path,revision:await api.packageRevision(doc),features:api.packageFeatures(doc),integrations:api.integrationRequirements(doc),views:doc.set.views??{},layouts:doc.set.layouts.map(l=>({id:l.id,name:l.label,width:l.width,height:l.height})),...scope};
  }
  function tool(name,description,inputSchema,readOnly,fn,external=false) {
    server.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly,openWorldHint:external}},async input=>{
      try{return reply(await fn(input));}
      catch(error){
        // Do not echo arbitrary file contents or user-supplied media in diagnostics.
        const message=error?.code==='ENOENT'?'Set file was not found in the configured directory.':error?.code==='ELOOP'?'Symbolic links are not accepted.':String(error?.message??'Authoring failed.').slice(0,1600);
        return {isError:true,content:[{type:'text',text:message}]};
      }
    });
  }
  tool('producer_capabilities','Discover the local compiler profile, plan/edit instructions and validation limits. This is not a connected native renderer capability probe.',{},true,async()=>({catalog:api.AUTHORING_CATALOG,target,instructions:api.DESIGN_INSTRUCTIONS,directory:root,publishing:{enabled:publishing,origin:'https://producer.dev',packageBytes:8388608,credentials:'existing Boomin CLI login; never included in packages'},...scope}));
  tool('producer_schema','Read the exact canonical package schema or a focused authoring section. No media, credentials or native actions.',{section:z.enum(['package','node','runtime','integrations','animation']).optional()},true,async({section='package'})=>{
    const full=api.presentationJsonSchema,fragment=section==='package'?full:section==='node'?full.$defs.node:section==='animation'?full.properties.set.properties.layouts.items.properties.animation:full.properties[section];
    const definitions={},seen=new Set();
    const collect=value=>{if(!value||typeof value!=='object')return;if(typeof value.$ref==='string'&&value.$ref.startsWith('#/$defs/')){const key=value.$ref.slice(8);if(!seen.has(key)&&full.$defs[key]){seen.add(key);definitions[key]=full.$defs[key];collect(full.$defs[key]);}}Object.values(value).forEach(collect);};
    if(section!=='package')collect(fragment);
    return {section,schema:section==='package'?full:{...fragment,...(Object.keys(definitions).length?{$defs:definitions}:{})},...scope};
  });
  tool('producer_requirements','Discover portable integration roles/contracts and required visual features. Import is allowed without a provider; connections remain local.',{file:fileName},true,async({file})=>{const doc=await read(file);return {integrations:api.integrationRequirements(doc),features:api.packageFeatures(doc),credentialsIncluded:false,...scope};});
  tool('producer_list_sets','List Set packages in the configured authoring directory.',{},true,async()=>({files:(await readdir(root,{withFileTypes:true})).filter(f=>f.isFile()&&fileName.safeParse(f.name).success).map(f=>f.name).sort().slice(0,200)}));
  tool('producer_inspect_set','Read an existing Set tree and revision with asset bytes removed. Use its stable IDs for edits.',{file:fileName},true,async({file})=>{const doc=await read(file);const context=api.designContext(doc);if(Buffer.byteLength(JSON.stringify(context))>1024*1024)throw Error('Set context exceeds 1 MB; use the local file workflow.');return {revision:await api.packageRevision(doc),context,...scope};});
  tool('producer_compile_set','Compile a compact or full canonical design plan to a new validated .set.json file. Optional assetsFrom supplies existing authorized asset IDs; embedded assets never enter the tool response.',{plan:document,assetsFrom:fileName.optional()},false,async({plan,assetsFrom})=>{checkDesign(plan);const assets=assetsFrom?(await read(assetsFrom)).set.assets:{};return save(api.compileDesignPlan(plan,target,assets));});
  tool('producer_edit_set','Apply atomic revision-fenced edits and save a new draft. The original file stays intact. Inspect the current revision first.',{file:fileName,edit:document},false,async({file,edit})=>{
    checkDesign(edit);const base=await read(file),revision=await api.packageRevision(base);
    const session=await api.createSetAuthoringSession(base,target);
    const {document:next}=await session.edit({operationId:randomUUID(),baseRevision:revision,label:'MCP Set edit',command:{type:'canonical',edit}});
    if(await api.packageRevision(await read(file))!==revision)throw Error('The source Set changed during this edit. Inspect it again.');
    return save(next);
  });
  tool('producer_validate_set','Validate the full canonical Set schema, including features beyond compact plans. Structural validity does not establish native readiness.',{file:fileName},true,async({file})=>{const doc=await read(file);return {ok:true,id:doc.id,revision:await api.packageRevision(doc),layouts:doc.set.layouts.length,...scope};});
  tool('producer_check_geometry','Check ring/camera alignment, radius, wave padding and possible text-box overlaps. Text glyph fit needs the browser visual check.',{file:fileName},true,async({file})=>api.checkVisualGeometry(await read(file)));
  tool('producer_visual_check','Render every configured layout in an installed Chromium browser and measure text fit, ring geometry and possible overlaps. Uses placeholder cameras, does not capture devices or verify native output.',{file:fileName},true,async({file})=>{const doc=await read(file);return {revision:await api.packageRevision(doc),...await checkRenderedSet(doc)};});
  tool('producer_repair_ring','Fit one ring around a selected circular camera with 90px wave space. Requires the exact current revision, preserves the camera and saves a new draft. Refuses if there is insufficient canvas space.',{file:fileName,baseRevision:z.string().regex(/^[a-f0-9]{64}$/),layout:z.string(),ring:z.string(),camera:z.string()},false,async({file,...input})=>{
    const base=await read(file),next=await api.repairCameraRing(base,input);
    if(await api.packageRevision(await read(file))!==input.baseRevision)throw Error('The source Set changed during repair. Inspect it again.');
    return save(next);
  });
  tool('producer_preview_set','Create a standalone HTML browser preview using Producer’s actual SetPreview renderer. Optionally export a publication thumbnail using an installed Chromium browser. Cameras are placeholders and audio is simulated. Does not load preparation or put anything on air.',{file:fileName,exportThumbnail:z.boolean().optional(),layout:z.string().max(64).optional()},false,async({file,exportThumbnail,layout})=>{
    const doc=await read(file);
    const name=`preview-${randomUUID()}.html`,path=await writeNew(name,await previewHtml(doc));
    const thumbnail=exportThumbnail?`poster-${randomUUID()}.jpg`:undefined;
    const thumbnailPath=thumbnail?await writeNew(thumbnail,await renderPublicationPreview(doc,layout)):undefined;
    return {path,packageFile:file,revision:await api.packageRevision(doc),preview:'browser-simulation',...(thumbnail?{thumbnail,thumbnailPath,thumbnailSource:'isolated Set renderer; placeholder cameras'}:{}),...scope};
  });
  if(publishing){
    const workspace=z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    tool('producer_list_publications','List published and private Set revisions for an explicitly selected Boomin workspace using the signed-in CLI account.',{workspace},true,async({workspace})=>listPublications(workspace),true);
    tool('producer_publish_set','Push a portable Set to producer.dev under its Boomin workspace handle. Public/unlisted downloads require confirmPublic=true. Authored values and embedded media are shared; account credentials, devices and room output are never used. Private is the default.',{
      file:fileName,workspace,slug:z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),title:z.string().min(1).max(120).optional(),description:z.string().max(2000).optional(),
      visibility:z.enum(['private','unlisted','public']).default('private'),confirmPublic:z.boolean().default(false),idempotencyKey:z.string().uuid(),publicationId:z.string().uuid().optional(),expectedRevision:z.number().int().positive().optional(),thumbnail:z.string().regex(/^poster-[a-f0-9-]{36}\.jpg$/).optional(),
    },false,async({file,workspace,thumbnail,...options})=>publishPackage(JSON.stringify(await read(file)),{...options,brand:workspace,thumbnailPath:thumbnail?join(root,thumbnail):undefined}),true);
    tool('producer_withdraw_set','Withdraw a published Set from producer.dev. Uses its exact current revision; public metadata, downloads and previews stop resolving. Existing downloaded copies are unaffected.',{
      workspace,publicationId:z.string().uuid(),expectedRevision:z.number().int().positive(),idempotencyKey:z.string().uuid(),
    },false,async({workspace,publicationId,expectedRevision,idempotencyKey})=>publishingRequest(workspace,`/v1/app/producer/v1/sets/publications/${publicationId}`,{method:'PATCH',body:{status:'withdrawn',expected_revision:expectedRevision,idempotency_key:idempotencyKey}}),true);
  }
  server.registerResource('authoring-guide','producer://authoring/guide',{mimeType:'application/json',description:'Producer compiler capabilities and compact plan/edit contract'},async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify({catalog:api.AUTHORING_CATALOG,instructions:api.DESIGN_INSTRUCTIONS,...scope})}]}));
  server.registerResource('canonical-schema','producer://authoring/schema',{mimeType:'application/schema+json',description:'Full canonical Set JSON schema from the installed checkout; used directly by canonical v2 plans and edits. Load for advanced authoring.'},async uri=>({contents:[{uri:uri.href,mimeType:'application/schema+json',text:JSON.stringify(api.presentationJsonSchema)}]}));
  return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=process.env.PRODUCER_SETS_DIR??join(homedir(),'Documents','Producer Sets');
  const server=await createAuthoringServer(directory);
  await server.connect(new StdioServerTransport());
}
