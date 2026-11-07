const ease=t=>t*t*(3-2*t);
function at(ms,points){if(ms<0||ms>=points.at(-1)[0])return points.at(-1)[1];const i=points.findIndex((p,i)=>i>0&&p[0]>=ms);const a=points[i-1],b=points[i],t=ease((ms-a[0])/(b[0]-a[0]));return a[1]+(b[1]-a[1])*t;}
export const DROP_DURATION_MS=12000;
export const DROP_HITS=[[0,0],[180,-.2],[460,1],[1150,.3],[2400,.08],[3100,-.15],[3700,.9],[4600,.35],[6000,.12],[6700,-.1],[7300,1],[8200,.4],[9600,.15],[10400,.65],[11200,.12],[12000,0]];
export const DROP_TURNS=[[0,0],[180,-.2],[460,1],[1150,-.35],[2400,.15],[3100,.4],[3700,-1],[4600,.3],[6000,-.2],[6700,-.5],[7300,1],[8200,-.35],[9600,.15],[10400,-.6],[11200,.1],[12000,0]];
/** Twelve-second three-hit choreography, driven by one local clock. */
export function dropMotion(ms,strength=1){const s=Math.max(0,Math.min(2,strength)),active=s>0&&ms>=0&&ms<DROP_DURATION_MS,hit=at(ms,DROP_HITS)*s,turn=at(ms,DROP_TURNS)*s;
 return {active,impact:Math.max(0,hit),sweep:active?Math.sin(ms/650)*Math.min(1,s):0,titleScale:Math.min(.1,hit*.085),titleX:turn*.14,titleY:hit*.2,tilt:turn*.12,roll:turn*.018,wave:1+Math.max(-.2,hit)*.95};}
