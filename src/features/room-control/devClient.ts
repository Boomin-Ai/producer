import {controlState,executeRoomControl} from './runtime';
if(import.meta.hot&&import.meta.env.VITE_ROOM_CLI==='1'&&'__TAURI_INTERNALS__' in window) {
  const clientId=crypto.randomUUID();
  const {getIdentifier}=await import('@tauri-apps/api/app');
  const identifier=await getIdentifier();
  if(!['ai.boomin.producer.sets-v2-dev','ai.boomin.producer.windows-network-dev'].includes(identifier))throw Error('Room CLI requires the isolated development bundle.');
  const ready=()=>import.meta.hot?.send('producer:room-ready',{clientId,identifier});
  ready();import.meta.hot.on('vite:ws:connect',ready);
  // Commands are delivered over the existing loopback Vite HMR connection.
  // No timers, room-frame subscriptions or extra native work while idle.
  import.meta.hot.on('producer:room-command',async request=>{
    try {
      const result=request.surface==='*'&&request.command==='state'?controlState():await executeRoomControl(request);
      import.meta.hot?.send('producer:room-result',{id:request.id,clientId,result});
    }catch(error){import.meta.hot?.send('producer:room-result',{id:request.id,clientId,error:error instanceof Error?error.message:String(error)});}
  });
}
