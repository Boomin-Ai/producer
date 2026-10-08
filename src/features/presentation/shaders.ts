export interface ShaderEffect {
 effect:'aurora'|'edgeGlow'|'lightSweep'|'plasma'|'silk'|'rings'|'grid'|'stars'|'petals'|'contours'|'prism'|'borderFlare';
 colors:string[];speed:number;intensity:number;scale:number;
 opacity:number;radius:number;quality:'low'|'medium';clock:'show'|'segment';
}
export const SHADER_DEFAULTS:ShaderEffect={effect:'aurora',colors:['#090e20','#397dce','#be70df'],speed:1,intensity:1,scale:1,opacity:1,radius:24,quality:'low',clock:'segment'};
