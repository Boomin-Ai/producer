import {roomAccessFrom,type RoomAccessResult} from './participants';

export type ProducerLocalAccessReceipt<T extends RoomAccessResult=RoomAccessResult>={
 endpointId:string;serverRoomId:string;result:Promise<T|null>;
};
/** This authorizes the LOCAL render room, never the remote appearance venue.
 * A completed HTTP response stays scoped when handed from Home into LiveView.
 * Missing/legacy access responses are never an implicit Boomin host grant. */
export async function producerLocalAccess<T extends RoomAccessResult>(input:{
 endpointId:string;serverRoomId:string;current:()=>boolean;
 receipt?:ProducerLocalAccessReceipt<T>;read:()=>Promise<T|null>;
}){
 const check=()=>{if(!input.current())throw new DOMException('The local room authorization was cancelled.','AbortError');};
 check();
 const receipt=input.receipt;
 const raw=await (receipt?.endpointId===input.endpointId&&receipt.serverRoomId===input.serverRoomId?receipt.result:input.read());
 check();
 const info=roomAccessFrom(raw);
 if(!raw||!info.known||info.role!=='host'||!info.can.manage)throw Error('Host access to the selected local room is required before sending its Set.');
 return {raw,info};
}
