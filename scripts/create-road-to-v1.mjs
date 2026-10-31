import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaults={landscape:path.join(root,'docs/shows/media/road-to-v1-landscape.png'),portrait:path.join(root,'docs/shows/media/road-to-v1-portrait.png'),output:path.join(root,'docs/shows/road-to-v1.json')};
const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const value=key=>({get:`values.${key}`});
function embeddedPng(file){
  if(!fs.existsSync(file))throw Error(`Road To V1 background is missing: ${file}. Generate both clean plates before building the Set.`);
  const bytes=fs.readFileSync(file);
  if(bytes.length>12*1024*1024)throw Error(`Road To V1 background exceeds the 12 MB embedded asset limit: ${file}`);
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error(`Road To V1 background must be a PNG: ${file}`);
  return {name:path.basename(file),mime:'image/png',data:`data:image/png;base64,${bytes.toString('base64')}`};
}

/** Reproducible, self-contained import package: no local media IDs or URLs. */
export async function createRoadToV1(options={}){
  const files={...defaults,...options};
  const assets={landscape:embeddedPng(files.landscape),portrait:embeddedPng(files.portrait)};
  const layouts=[];
  for(const mode of ['live','title'])for(const orientation of ['landscape','portrait']){
    const portrait=orientation==='portrait',width=portrait?1080:1920,height=portrait?1920:1080;
    const sx=portrait?60:510,sy=portrait?730:430,sw=portrait?960:1000,sh=portrait?740:540;
    const live=mode==='live';
    layouts.push({id:`${mode}-${orientation}`,label:`${live?'Live':'Title'} · ${portrait?'Portrait':'Landscape'}`,width,height,
      animation:{tracks:[],transition:{type:'morph',durationMs:600,contentDurationMs:220}},
      root:{id:'road-to-v1',type:'box',styles:{position:'relative',width,height,overflow:'hidden',background:'#fdfdfd'},children:[
        {id:'road-cleanplate',type:'media',assetId:orientation,fit:'cover',styles:rect(0,0,width,height)},
        {id:'launch-lettering',type:'shader',styles:rect(sx,sy,sw,sh),shader:{effect:'launchV1',colors:['#00d9ff','#ed17df','#ffae24'],speed:live?.55:0,intensity:live?1.25:0,scale:1,opacity:1,radius:0,glow:.7,quality:'medium',clock:'show',bindings:{...(live?{intensity:value('sensitivity'),speed:value('motion')}:{}),glow:value('glow')}}},
      ]}});
  }
  const controls=[...layouts.map(layout=>({id:layout.id,type:'button',label:layout.label,action:{type:'layout.select',layoutId:layout.id}})),
    {id:'sensitivity',type:'number',label:'Voice sensitivity',key:'sensitivity'},
    {id:'motion',type:'number',label:'Motion speed',key:'motion'},
    {id:'glow',type:'number',label:'Neon glow',key:'glow'},
  ];
  const raw={schema:'producer.presentation/2',id:'road-to-v1',name:'Road To V1',version:'1.0.2',runtime:{schema:'producer.modules/1',definitions:{},instances:[]},set:{
    initialLayout:'live-landscape',assets,values:{sensitivity:{type:'number',default:1.25,min:0,max:2},motion:{type:'number',default:.55,min:0,max:4},glow:{type:'number',default:.7,min:0,max:1}},feeds:{},slots:[],components:{},layouts,controls,
    controlArrangement:{sections:[{id:'composition',label:'Composition',controls:layouts.map(l=>`set:${l.id}`)},{id:'lighting',label:'Voice and lighting',controls:['set:sensitivity','set:motion','set:glow']}],minimized:[...layouts.map(l=>`set:${l.id}`),'set:sensitivity']},
  }};
  const bundle=await build({stdin:{contents:"export {parsePackage} from './src/features/presentation/schema';",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false});
  const {parsePackage}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const doc=parsePackage(raw),json=JSON.stringify(doc);
  if(Buffer.byteLength(json)>40*1024*1024)throw Error('Road To V1 package exceeds the 40 MB import limit.');
  if(files.output){fs.mkdirSync(path.dirname(files.output),{recursive:true});fs.writeFileSync(files.output,json);}
  return doc;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  try{
    for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!['landscape','portrait','output'].includes(key)||!args[i+1])throw Error('Usage: node scripts/create-road-to-v1.mjs [--landscape image.png] [--portrait image.png] [--output set.json]');options[key]=path.resolve(args[i+1]);}
    const doc=await createRoadToV1(options);console.log(`Built ${doc.name}: four camera-free layouts with embedded backgrounds. ${options.output??defaults.output}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
