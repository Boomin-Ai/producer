export interface Scene3dCamera {position:[number,number,number];target:[number,number,number];fov:number}
export interface Scene3dWorld {
 schema:'producer.scene3d/1';fps:30|60;clearColor:string;fog:{color:string;near:number;far:number};camera:Scene3dCamera;
 objects:Array<{id:string;kind:'box'|'roundedBox'|'cylinder'|'torus'|'cone'|'plane'|'sphere';args:number[];position:number[];rotation:number[];color:string;metalness:number;roughness:number;emissive?:string;emissiveIntensity?:number;opacity?:number;unlit?:boolean;visible?:boolean;pass?:'background'|'foreground';motion?:{clock?:'set'|'cue';kind:'rotateY'|'swayZ'|'moveY';speed:number;amplitude:number;phase:number};castShadow?:boolean;receiveShadow?:boolean}>;
 frameStyles?:Array<{color?:string;metalness?:number;roughness?:number;thickness?:number;depth?:number;radius?:number}>;slots:number[][];views?:Record<string,Scene3dCamera>;environment?:'none'|'studio';exposure?:number;environmentIntensity?:number;cueDurationMs?:number;cues?:Record<string,{visibility?:Record<string,boolean>;lights?:Record<string,number>;view?:string;durationMs?:number}>;lights?:Array<{position:number[];color:string;intensity:number;id:string}>;
}
export interface Scene3dControl {rendering?:boolean;revision:number;anchor:number;elapsed:number;paused:boolean;cue:string;cueSequence?:number;view?:string}
export interface Scene3dLayer {id:string;pass:'background'|'foreground';world:Scene3dWorld;cue:string;cueSequence?:number;view?:string}
export function parseWorld(v:unknown):Scene3dWorld;
export function parseControl(v:unknown):Scene3dControl;
export const WORLD_SCHEMA:Record<string,unknown>;
