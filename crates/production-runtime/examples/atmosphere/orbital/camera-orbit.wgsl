// All lengths below are in units of output height. The presenter stays upright.
let world=textureSample(input0,linear_sampler,uv).rgb;
let phase=t*0.39269908;
let axes=radius*select(vec2<f32>(1.72,.56),vec2<f32>(1.26,.70),portrait);
let tilt=select(-.14,-.09,portrait);
let rotation=mat2x2<f32>(vec2<f32>(cos(tilt),sin(tilt)),vec2<f32>(-sin(tilt),cos(tilt)));
let delta=(uv-center)*vec2<f32>(aspect,1.);
let depth=sin(phase);
let anchor=rotation*(axes*vec2<f32>(cos(phase),depth));
let near=smoothstep(-1.,1.,depth);
let diameter=radius*mix(.82,1.20,near);
let cam_uv=(delta-anchor)/diameter+.5;
let inside=all(cam_uv>=vec2<f32>(0.)) && all(cam_uv<=vec2<f32>(1.));
let tile=textureSample(input1,linear_sampler,frame.params.xy+clamp(cam_uv,vec2<f32>(0.),vec2<f32>(1.))*frame.params.zw);
let pixel=1./frame.info.y;
let planet=1.-smoothstep(radius-1.3*pixel,radius+1.3*pixel,length(delta));
let back=1.-smoothstep(-.12,.12,depth);
let visible=select(0.,1.,inside)*(1.-planet*back);
let pos=transpose(rotation)*delta/axes;
let distance=abs(length(pos)-1.)*min(axes.x,axes.y);
let track=(1.-smoothstep(.35*pixel,1.5*pixel,distance))*(1.-planet*(1.-smoothstep(-.05,.05,pos.y)));
let rail=world+vec3<f32>(.21,.50,.46)*track*.54;
let light=mix(vec3<f32>(.82,.89,1.),vec3<f32>(1.,.98,.94),near);
// Illuminate the outer pixels of the actual circular presenter bezel.
let edge=length(cam_uv-.5);
let bevel=smoothstep(.5-3.*pixel/diameter,.5-1.4*pixel/diameter,edge);
let glint=mix(vec3<f32>(.27,.68,.73),vec3<f32>(.99,.75,.43),smoothstep(-.50,.35,cam_uv.x-cam_uv.y));
let presenter=mix(tile.rgb*light,glint*tile.a,bevel*.92);
return vec4<f32>(rail*(1.-tile.a*visible)+presenter*visible,1.);
