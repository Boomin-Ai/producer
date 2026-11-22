let object=textureSample(input0,linear_sampler,uv);
let q=(uv-vec2<f32>(0.5))*vec2<f32>(frame.info.x/frame.info.y,1.);
let id=floor(position.xy/4.);
let seed=fract(sin(dot(id,vec2<f32>(17.127,81.217)))*43758.54);
let dotStar=exp(-2.5*dot(fract(position.xy/4.)-0.5,fract(position.xy/4.)-0.5)*6.);
let halo=exp(-4.0*length(q-vec2<f32>(-.16,-.04)));
let mist=exp(-10.0*abs(q.y+.18*q.x+.06*sin(4.*q.x)));
let sky=vec3<f32>(.009,.026,.052)+halo*vec3<f32>(.02,.11,.12)+mist*vec3<f32>(.027,.034,.056)
    +step(.990,seed)*dotStar*vec3<f32>(.58,.70,.72);
return vec4<f32>(mix(sky,object.rgb,object.a),1.);
