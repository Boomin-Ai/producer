// Server-only credentials. Never include this object in client responses/logs.
export function fixtureConnection(env) {
 if(env.LIVEKIT_LAB_CLOUD_TEST!=='1')return {url:env.LIVEKIT_LAB_PACKET_PROXY==='1'?'ws://127.0.0.1:7885':'ws://127.0.0.1:7880',key:'devkey',secret:'secret',roomName:env.LIVEKIT_LAB_SYNC_STREAMS==='1'?'producer-g1-sync-lab':'producer-g1-lab'};
 const url=env.LIVEKIT_URL;
 if(!/^wss:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.livekit\.cloud$/.test(url??''))throw new Error('Cloud test needs an exact TLS project URL');
 if(!/^producer-g1-cloud-[0-9]+$/.test(env.LIVEKIT_LAB_CLOUD_ROOM??''))throw new Error('Cloud test requires its own temporary room');
 if(!env.LIVEKIT_API_KEY||!env.LIVEKIT_API_SECRET)throw new Error('Cloud server credentials are missing');
 return {url,key:env.LIVEKIT_API_KEY,secret:env.LIVEKIT_API_SECRET,roomName:env.LIVEKIT_LAB_CLOUD_ROOM};
}
