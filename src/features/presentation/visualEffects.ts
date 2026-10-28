/** Versioned, bounded compositor effects. Coordinates are local normalized
 * units; feather/blur are logical pixels, independent of output resolution. */
export interface LayerMask {kind:'rounded'|'circle'|'wipe';radius?:number;progress?:number;x?:number;y?:number;feather?:number;invert?:boolean;direction?:'left'|'right'|'up'|'down'}
export interface BackdropEffect {blur:number}
export const VISUAL_CAPABILITIES=['mask@1','backdrop@1','chart@1'] as const;
export function validateMask(m:LayerMask){
 if(!m||!['rounded','circle','wipe'].includes(m.kind)||Object.keys(m).some(k=>!['kind','radius','progress','x','y','feather','invert','direction'].includes(k)))throw Error('Invalid layer mask');
 for(const [key,max]of [['radius',960],['progress',1],['x',1],['y',1],['feather',32]] as const){const v=m[key];if(v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max))throw Error('Invalid mask '+key);}
 if(m.kind==='rounded'&&(m.progress!==undefined||m.invert===true))throw Error('Rounded clipping uses radius; use circle or wipe for animated/inverted masks');
 if(m.invert!==undefined&&typeof m.invert!=='boolean'||m.direction!==undefined&&!['left','right','up','down'].includes(m.direction))throw Error('Invalid mask mode');
}
export function validateBackdrop(b:BackdropEffect){if(!b||Object.keys(b).some(k=>k!=='blur')||!Number.isFinite(b.blur)||b.blur<0||b.blur>24)throw Error('Invalid backdrop blur');}
