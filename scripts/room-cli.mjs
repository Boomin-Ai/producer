#!/usr/bin/env node
import {readFileSync} from 'node:fs';
const [surface='*',command='state',input]=process.argv.slice(2);
if(surface==='--help'){console.log('node scripts/room-cli.mjs [surface] [command] [JSON or @file]\nStart dev with VITE_ROOM_CLI=1. State includes the command catalog.\nMutations read the current surface epoch, then reject if navigation changed it.\nExamples: room panel.move \'{"panel":"assistant","dock":"bottom"}\'\n          room set.load \'{"id":"my-set"}\'\n          assistant prompt \'{"text":"Create a new Set"}\'');process.exit(0);}
try{
 const {url,token}=JSON.parse(readFileSync(new URL('../.room-control/session.json',import.meta.url),'utf8'));
 const call=async body=>{const response=await fetch(url+'/__producer_room_cli',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok||data.error)throw Error(data.error??response.statusText);return data.result;};
 const args=input?JSON.parse(input.startsWith('@')?readFileSync(input.slice(1),'utf8'):input):{};
 const current=command==='state'?{}:await call({surface,command:'state'});
 const result=await call({surface,command,args,...(command==='state'?{}:{roomId:current.roomId,epoch:current.epoch})});
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
