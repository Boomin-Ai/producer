/** Shared media appearance contract: ordinary source editing and set slots.
 * Units are pixels at the placement's render size. Native adapters must resolve
 * placement size before applying this; CSS on an overlay is insufficient. */
export interface SourceAppearance {
  shape: 'rectangle' | 'circle'; cornerRadius: number; outlineWidth: number;
  outlineColor: string; grayscale: number; opacity: number;
}
export const DEFAULT_SOURCE_APPEARANCE: Readonly<SourceAppearance> = Object.freeze({
  shape:'rectangle',cornerRadius:0,outlineWidth:0,outlineColor:'#ffffff',grayscale:0,opacity:1,
});
export const sourceAppearanceSchema = {
 type:'object',additionalProperties:false,properties:{
  shape:{enum:['rectangle','circle']},cornerRadius:{type:'number',minimum:0,maximum:960},
  outlineWidth:{type:'number',minimum:0,maximum:64},outlineColor:{type:'string',pattern:'^#[a-fA-F0-9]{6}$'},
  grayscale:{type:'number',minimum:0,maximum:1},opacity:{type:'number',minimum:0,maximum:1},
 },
};
export function parseSourceAppearance(value: unknown): SourceAppearance {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('Appearance must be a plain object');
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(!Object.prototype.hasOwnProperty.call(DEFAULT_SOURCE_APPEARANCE,key))throw new Error(`Unknown appearance field: ${key}`);
 const out={...DEFAULT_SOURCE_APPEARANCE,...input} as SourceAppearance;
 if(!['rectangle','circle'].includes(out.shape))throw new Error('Invalid source shape');
 if(typeof out.outlineColor!=='string'||!/^#[a-fA-F0-9]{6}$/.test(out.outlineColor))throw new Error('Outline must be a six-digit hex color');
 for(const [key,max] of [['cornerRadius',960],['outlineWidth',64],['grayscale',1],['opacity',1]] as const){const n=out[key];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>max)throw new Error(`Invalid appearance ${key}`);}
 return out;
}
