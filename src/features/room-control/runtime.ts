/** Named host operations shared by the room UI and the opt-in development CLI.
 * No eval, native invoke proxy, credentials or media bytes cross this boundary.
 * The internal registry is available to the host Assistant. Only the CLI
 * transport is development-only; it is never shipped as an external API. */
export interface ControlRequest {surface:string; command:string; args?:Record<string,unknown>; roomId?:string; epoch?:string}
export interface ControlSurface {epoch:string; roomId?:string; snapshot():unknown; commands:Record<string,(args:Record<string,any>)=>unknown>}
const surfaces:Map<string,ControlSurface>=import.meta.hot?.data.roomSurfaces??new Map();
if(import.meta.hot)import.meta.hot.data.roomSurfaces=surfaces;
export function registerRoomControl(name:string,surface:ControlSurface) {
  surfaces.set(name,surface);
  return ()=>{if(surfaces.get(name)===surface)surfaces.delete(name);};
}
export function controlState() {return {schema:'producer.room-state/1',...Object.fromEntries([...surfaces].map(([name,value])=>[name,{epoch:value.epoch,roomId:value.roomId,state:redactRoomState(value.snapshot()),commands:Object.keys(value.commands)}]))};}
export async function executeRoomControl(request:ControlRequest) {
  const surface=surfaces.get(request.surface);
  if(!surface)throw Error('That surface is not open. Read state and navigate first.');
  if(request.command==='state')return {schema:'producer.room-state/1',epoch:surface.epoch,roomId:surface.roomId,state:redactRoomState(surface.snapshot()),commands:Object.keys(surface.commands)};
  if(!request.epoch||request.epoch!==surface.epoch||surface.roomId!==request.roomId)throw Error('The room or surface changed. Read fresh state before sending a command.');
  const handler=Object.prototype.hasOwnProperty.call(surface.commands,request.command)?surface.commands[request.command]:undefined;
  if(!handler)throw Error('Unsupported command. Read the surface command catalog.');
  return redactRoomState(await handler(request.args??{}));
}
/** Preserve the document's structure, replacing private values with markers.
 * Capture specifications may contain userinfo, signed URLs and local paths. */
export function redactRoomState(value:unknown,key=''):unknown {
  if(/token|secret|password|authorization|cookie|invite_url|guest_link|render_url|access_key|stream_key|credential|api_key|recpath/i.test(key))return '[private]';
  if(key==='assets'&&value&&typeof value==='object'&&!Array.isArray(value))return Object.fromEntries(Object.entries(value).map(([id,asset])=>[id,asset&&typeof asset==='object'?{name:(asset as any).name,mime:(asset as any).mime,data:'[embedded asset]'}:'[embedded asset]']));
  if(typeof value==='string'){
    if(/^(https?|wss?):\/\//i.test(value))return '[private location]';
    if(value.startsWith('data:'))return '[embedded asset]';
    if(/url|uri|path|file|base_url/i.test(key))return '[private location]';
    return value;
  }
  if(Array.isArray(value))return value.map(item=>redactRoomState(item,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redactRoomState(v,k)]));
  return value;
}
