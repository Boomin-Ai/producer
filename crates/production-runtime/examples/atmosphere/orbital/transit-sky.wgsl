// A graduated brass instrument and an atmosphere scattering light onto the desk.
let direction=p/max(r,.0001);
let sky=mix(vec3<f32>(.018,.034,.069),vec3<f32>(.020,.155,.175),clamp(.61-.36*uv.y+.15*direction.x,0.,1.));
let aura=exp(-abs(r-1.)*3.5);
let ang=atan2(p.y,p.x);
let bezel=(1.-smoothstep(1.016,1.11,r))*smoothstep(.978,1.01,r);
let engrave=pow(max(0.,cos(ang*144.)),14.)*bezel;
let key=clamp(dot(direction,normalize(vec2<f32>(-.39,-.74))) *.5+.5,0.,1.);
let fixedRing=exp(-abs(r-1.083)/max(pixel,0.0012))*.66+exp(-abs(r-1.160)*95.)*.11;
let q=(uv-vec2<f32>(.12,.81))*vec2<f32>(aspect,1.);
let distanceToStation=length(q+vec2<f32>(.04*sin(t*.12),-.08));
let scale=abs(fract(distanceToStation*10.+.07*sin(t*.15))-.5);
let chart=1.-smoothstep(.004,max(.018,fwidth(distanceToStation)*12.),scale);
let stipple=pow(max(0.,cos(position.x*1.04)*cos(position.y*1.04)),6.);
let glint=exp(-abs(local.y-axes.y*.35)*8.)*exp(-abs(r-1.27)*2.5);
let patina=mix(jade,gold,key);
return vec4<f32>(sky+patina*(aura*.12+fixedRing*.55+engrave*.52)+jade*(chart*.105+stipple*.021)+gold*glint*.052,1.);
