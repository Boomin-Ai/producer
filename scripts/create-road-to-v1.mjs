import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaults={landscape:path.join(root,'docs/shows/media/road-to-v1-landscape.png'),portrait:path.join(root,'docs/shows/media/road-to-v1-portrait.png'),output:path.join(root,'docs/shows/road-to-v1.json')};
const rect=(left,top,width,height)=>({position:'absolute',left,top,width,height});
const value=key=>({get:`values.${key}`});
function embeddedImage(file){
  if(!fs.existsSync(file))throw Error(`Road To V1 background is missing: ${file}. Generate both clean plates before building the Set.`);
  const bytes=fs.readFileSync(file);
  if(bytes.length>12*1024*1024)throw Error(`Road To V1 background exceeds the 12 MB embedded asset limit: ${file}`);
  const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':null;
  if(!mime)throw Error(`Road To V1 artwork must be PNG or JPEG: ${file}`);
  return {name:path.basename(file),mime,data:`data:${mime};base64,${bytes.toString('base64')}`};
}

/** Reproducible, self-contained import package: no local media IDs or URLs. */
export async function createRoadToV1(options={}){
  const files={...defaults,...options};
  const assets={landscape:embeddedImage(files.landscape),portrait:embeddedImage(files.portrait),title:embeddedImage(path.join(root,'docs/shows/media/road-to-v1-title.png')),host:embeddedImage(path.join(root,'docs/shows/media/road-to-v1-host.jpg'))};
  const layouts=[];
  for(const mode of ['live','title'])for(const orientation of ['landscape','portrait']){
    const portrait=orientation==='portrait',width=portrait?1080:1920,height=portrait?1920:1080;
    const sx=portrait?60:105,sy=portrait?650:480,sw=portrait?960:1150,sh=portrait?800:530;
    const live=mode==='live';
    layouts.push({id:`${mode}-${orientation}`,label:`${live?'Live':'Title'} · ${portrait?'Portrait':'Landscape'}`,width,height,
      animation:{tracks:[],transition:{type:'morph',durationMs:600,contentDurationMs:0}},
      root:{id:'road-to-v1',type:'box',styles:{position:'relative',width,height,overflow:'hidden',background:'#fdfdfd'},children:[
        {id:'road-cleanplate',type:'media',assetId:orientation,fit:'cover',styles:rect(0,0,width,height)},
        {id:'header-cleanplate',type:'box',styles:{...rect(0,0,width,portrait?620:530),background:'#ffffff'},children:[]},
        {id:'centered-title',type:'media',assetId:'title',fit:'contain',styles:portrait?rect(35,95,1010,444):rect(130,25,1100,484)},
        {id:'caption-panel',type:'box',styles:{...rect(portrait?70:1280,portrait?1410:240,portrait?940:580,portrait?430:790),background:'linear-gradient(135deg, #00d9ff 0%, #ed17df 50%, #ffae24 100%)',borderRadius:22,overflow:'hidden'},children:[
          {id:'caption-panel-inner',type:'box',styles:{...rect(3,3,portrait?934:574,portrait?424:784),background:'#0b0b0c',borderRadius:19},children:[]},
        ]},
        {id:'caption-portrait',type:'box',styles:{...rect(portrait?105:1320,portrait?1440:275,portrait?88:112,portrait?88:112),overflow:'hidden',borderRadius:12},children:[
          {id:'caption-portrait-photo',type:'media',assetId:'host',fit:'cover',styles:portrait?rect(-42,-4,194,161):rect(-53,-5,246,204)},
        ]},
        {id:'caption-host-name',type:'text',text:'KLEVELAND',styles:{...rect(portrait?220:1455,portrait?1452:307,portrait?720:360,55),fontFamily:'Impact, Arial Narrow, sans-serif',fontSize:portrait?34:38,fontWeight:400,letterSpacing:1,color:'#e9ffff'}},
        {id:'live-captions',type:'text',text:value('liveCaption'),styles:{...rect(portrait?110:1320,portrait?1555:425,portrait?860:500,portrait?250:555),fontFamily:'Impact, Arial Narrow, sans-serif',fontSize:portrait?58:72,fontWeight:400,lineHeight:1.03,letterSpacing:.6,textTransform:'uppercase',color:'#e9ffff',textAlign:portrait?'center':'left',textShadow:'2px 2px 0 #0b1420, -2px -2px 0 #0b1420, 4px 4px 0 #9d217a, 0 0 12px #00d9ff55',overflow:'hidden'}},
        {id:'launch-lettering',type:'shader',styles:rect(sx,sy,sw,sh),shader:{effect:'launchV1',colors:['#00d9ff','#ed17df','#ffae24'],speed:live?.55:0,intensity:live?1.25:0,scale:1,opacity:1,radius:0,glow:.7,quality:'medium',clock:'show',bindings:{...(live?{intensity:value('sensitivity'),speed:value('motion')}:{}),glow:value('glow')}}},
      ]}});
  }
  for(const orientation of ['landscape','portrait']){
    const portrait=orientation==='portrait',template=structuredClone(layouts.find(l=>l.id===`live-${orientation}`)),width=template.width,height=template.height;
    template.id=`sea-${orientation}`;template.label=`Sea · ${portrait?'Portrait':'Landscape'}`;
    template.root.children=[
      {id:'liquid-background',type:'shader',styles:rect(0,0,width,height),shader:{effect:'voiceSea',colors:['#00d9ff','#ed17df','#ffae24'],speed:.55,intensity:1.5,scale:1,opacity:1,radius:0,quality:'medium',clock:'show',glow:.7,bindings:{intensity:value('seaStrength'),speed:value('motion')}}},
      {id:'floating-title',type:'media',assetId:'title',fit:'contain',styles:portrait?rect(35,95,1010,444):rect(130,25,1100,484)},
      ...template.root.children.filter(n=>['launch-lettering','caption-panel','caption-portrait','caption-host-name','live-captions'].includes(n.id)),
    ];layouts.push(template);
  }
  const controls=[...layouts.map(layout=>({id:layout.id,type:'button',label:layout.label,action:{type:'layout.select',layoutId:layout.id}})),
    {id:'sensitivity',type:'number',label:'Voice sensitivity',key:'sensitivity'},
    {id:'motion',type:'number',label:'Motion speed',key:'motion'},
    {id:'sea-strength',type:'number',label:'Sea response',key:'seaStrength'},
    {id:'glow',type:'number',label:'Neon glow',key:'glow'},
  ];
  const raw={schema:'producer.presentation/2',id:'road-to-v1',name:'Road To V1',version:'1.2.2',runtime:{schema:'producer.modules/1',definitions:{},instances:[]},set:{
    initialLayout:'sea-landscape',assets,values:{liveCaption:{type:'text',default:'',maxLength:80},seaStrength:{type:'number',default:1.5,min:0,max:2},sensitivity:{type:'number',default:1.25,min:0,max:2},motion:{type:'number',default:.55,min:0,max:4},glow:{type:'number',default:.7,min:0,max:1}},feeds:{},slots:[],components:{},layouts,controls,
    controlArrangement:{sections:[{id:'composition',label:'Composition',controls:layouts.map(l=>`set:${l.id}`)},{id:'lighting',label:'Voice and lighting',controls:['set:sensitivity','set:motion','set:glow','set:sea-strength']}],minimized:[...layouts.map(l=>`set:${l.id}`),'set:sensitivity']},
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
    const doc=await createRoadToV1(options);console.log(`Built ${doc.name}: six camera-free layouts with embedded backgrounds. ${options.output??defaults.output}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
