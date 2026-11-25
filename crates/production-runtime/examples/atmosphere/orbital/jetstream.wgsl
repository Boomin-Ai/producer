// Alternate full-frame art direction. Streamlines fold around a moving front.
let t=frame.info.z;
let aspect=frame.info.x/frame.info.y;
let p=vec2<f32>(uv.x*aspect,uv.y);
let lat=radians(frame.params.w);
let tempo=.07+clamp(frame.params.y,0.,80.)*.002;
let field=p.y*1.65+.28*sin(p.x*3.8-t*tempo+lat)+.14*cos(p.x*8.2+p.y*3.8+t*tempo*.8);
let ribbon=.5+.5*cos(field*9.1);
let fine=field*22.;
let line=1.-smoothstep(.008,max(.04,min(.24,fwidth(fine)*1.2)),abs(fract(fine+.5)-.5));
let swept=.5+.5*cos(p.x*4.1-field*3.7+t*.18);
let violet=vec3<f32>(.63,.25,.97);let coral=vec3<f32>(.99,.46,.26);
let cyan=vec3<f32>(.14,.92,.82);
let light=mix(mix(violet,coral,swept),cyan,smoothstep(.52,.92,uv.x));
let sky=vec3<f32>(.045,.022,.096)+vec3<f32>(.085,.052,.16)*ribbon;
let spine=pow(ribbon,12.0);
let grain=fract(sin(dot(floor(position.xy),vec2<f32>(12.11,31.72)))*3772.)*.016;
return vec4<f32>(sky+light*(spine*.45+line*(.10+.56*spine))+grain,1.);
