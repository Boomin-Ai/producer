import WebSocket from 'ws';
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>i%2?a:[...a,[x,v[i+1]]],[]));
const deck=new WebSocket(`ws://127.0.0.1:${args['-port']}`),uuid=args['-pluginUUID'];
const buttons=new Map();let remote,settings={},paired=false,room='',pads=[],lastStatus=null,retry,requests=new Map(),counter=0;
const send=(event,context,payload={})=>{if(deck.readyState===1)deck.send(JSON.stringify({event,context,payload}))};
function paint(){for(const [context,b]of buttons){const active=lastStatus?.playing?.includes(b.settings.sound);if(!b.action.endsWith('.volume'))send('setState',context,{state:active?1:0});const name=b.action.endsWith('.stop')?'STOP ALL':b.action.endsWith('.volume')?'EFFECTS':pads.find(p=>p.id===b.settings.sound)?.name||'Choose sound';send('setTitle',context,{title:paired?name.slice(0,34).replace(/ /g,'\n'):'Connect\nProducer',target:0});if(b.action.endsWith('.volume'))send('setFeedback',context,{value:Math.round((lastStatus?.volume??.8)*100),title:'Effects'});}}
function request(action,extra={}){if(!paired||!remote||remote.readyState!==1)return Promise.reject(Error('Connect Producer first'));const requestId=String(++counter);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{requests.delete(requestId);reject(Error('Producer did not answer'))},12000);requests.set(requestId,{resolve,reject,timer});remote.send(JSON.stringify({requestId,room,action,...extra}));});}
function publish(context){send('sendToPropertyInspector',context,{paired,room,pads,connection:settings.connection??'',error:settings.error??''})}
function connect(){clearTimeout(retry);if(remote){remote.removeAllListeners();remote.close()}paired=false;paint();let c;try{c=JSON.parse(settings.connection??'');if(!Number.isInteger(c.port)||c.port<1||c.port>65535||!/^[a-f0-9]{64}$/.test(c.token))throw Error('Invalid connection')}catch{return}
 remote=new WebSocket(`ws://127.0.0.1:${c.port}`);
 remote.on('open',()=>remote.send(JSON.stringify({token:c.token})));
 remote.on('message',async raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(m.type==='paired'){paired=true;settings.error='';try{const l=await request('list');room=l.room;pads=l.pads;paint();for(const c of buttons.keys())publish(c)}catch(e){settings.error=e.message}}
 if(m.type==='reply'){const p=requests.get(m.requestId);if(p){clearTimeout(p.timer);requests.delete(m.requestId);m.ok?p.resolve(m.data):p.reject(Error(m.error));}}
 if(m.type==='status'){const changed=room!==m.data?.room;lastStatus=m.data;room=m.data?.room??'';if(changed&&room)request('list').then(l=>{pads=l.pads;for(const c of buttons.keys())publish(c)}).catch(()=>{});paint();}});
 remote.on('error',()=>{});remote.on('close',()=>{paired=false;lastStatus=null;for(const r of requests.values()){clearTimeout(r.timer);r.reject(Error('Producer disconnected'))}requests.clear();paint();retry=setTimeout(connect,2000)});
}
deck.on('open',()=>{deck.send(JSON.stringify({event:args['-registerEvent'],uuid}));send('getGlobalSettings',uuid)});
deck.on('message',async raw=>{let e;try{e=JSON.parse(raw)}catch{return}const p=e.payload??{};
 if(e.event==='didReceiveGlobalSettings'){settings=p.settings??{};connect()}
 if(e.event==='willAppear'||e.event==='didReceiveSettings'){buttons.set(e.context,{action:e.action,settings:p.settings??{}});paint()}
 if(e.event==='willDisappear')buttons.delete(e.context);
 if(e.event==='sendToPlugin'){if(p.connection!==undefined){settings={connection:p.connection};send('setGlobalSettings',uuid,settings);connect()}if(p.refresh&&paired){try{const l=await request('list');room=l.room;pads=l.pads}catch(err){settings.error=err.message}}publish(e.context)}
 if(e.event==='keyDown'||e.event==='dialRotate'||e.event==='dialDown'){const b=buttons.get(e.context);if(!b)return;try{if(b.action.endsWith('.stop'))await request('stop_all');else if(b.action.endsWith('.volume')){const value=e.event==='dialDown'?0:Math.max(0,Math.min(1,(lastStatus?.volume??.8)+(p.ticks??1)*.02));if(lastStatus)lastStatus={...lastStatus,volume:value};paint();await request('volume',{value})}else await request('play',{id:b.settings.sound??''})}catch(err){send('showAlert',e.context);settings.error=err.message;publish(e.context)}}
});
process.on('SIGTERM',()=>{clearTimeout(retry);remote?.close();deck.close();process.exit(0)});
