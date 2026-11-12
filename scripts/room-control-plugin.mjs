import {randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdirSync,writeFileSync,chmodSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';

/** Explicitly enabled loopback-only development transport. Not a public API. */
export function roomControlPlugin() {
  const token=randomBytes(32).toString('hex'),pending=new Map(),clients=new Map();
  return {name:'producer-room-control',apply:'serve',
    transformIndexHtml(){return [{tag:'script',attrs:{type:'module',src:'/src/features/room-control/devClient.ts'},injectTo:'body'}];},
    configureServer(server){
      const dir=resolve('.room-control'),file=resolve(dir,'session.json');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
      server.httpServer?.once('listening',()=>{const address=server.httpServer.address();writeFileSync(file,JSON.stringify({url:`http://127.0.0.1:${address.port}`,token,pid:process.pid}),{mode:0o600});chmodSync(file,0o600);});
      server.httpServer?.once('close',()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error('Dev server closed.'));}pending.clear();try{unlinkSync(file);}catch{}});
      server.ws.on('producer:room-ready',(data,client)=>{if(!['ai.boomin.producer.sets-v2-dev','ai.boomin.producer.windows-network-dev'].includes(data.identifier))return;clients.set(client,data.clientId);client.socket.once('close',()=>clients.delete(client));});
      server.ws.on('producer:room-result',(data,client)=>{const item=pending.get(data.id);if(!item||item.client!==client)return;pending.delete(data.id);clearTimeout(item.timer);data.error?item.reject(Error(data.error)):item.resolve(data.result);});
      server.middlewares.use('/__producer_room_cli',async(req,res)=>{
        res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
        const reject=(status,message)=>{res.statusCode=status;res.end(JSON.stringify({error:message}));};
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!/^127\.0\.0\.1:\d+$/.test(req.headers.host??''))return reject(403,'Loopback only.');
        if(req.headers.origin||req.headers['sec-fetch-site'])return reject(403,'Use the local CLI.');
        const supplied=Buffer.from((req.headers.authorization??'').replace(/^Bearer /,'')),expected=Buffer.from(token);
        if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reject(401,'Unauthorized.');
        if(req.method!=='POST')return reject(405,'POST required.');
        try{
          let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2*1024*1024)throw Error('Command exceeds 2MB.');}
          const request=JSON.parse(body);if(typeof request.surface!=='string'||typeof request.command!=='string')throw Error('Expected a named surface and command.');
          if(pending.size>=8)throw Error('Too many pending commands.');
          if(clients.size!==1)throw Error(clients.size?'More than one dev window is connected. Close the extra window.':'Open the isolated dev app first.');
          const client=clients.keys().next().value;
          const id=randomBytes(16).toString('hex');
          const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('No response from the dev app. Do not repeat a mutation without checking state.'));},request.surface==='room'&&request.command==='clips.save'?90000:30000);pending.set(id,{resolve,reject,timer,client});client.send('producer:room-command',{...request,id});});
          res.end(JSON.stringify({result}));
        }catch(error){reject(400,error.message);}
      });
    }
  };
}
