let world=textureSample(input0,linear_sampler,uv).rgb;
let host=textureSample(input1,linear_sampler,uv);
let transition=sin(3.14159*frame.info.w);
let sweep=exp(-abs(uv.x+.32*uv.y-frame.info.w*1.42)*10.)*transition;
let air=vec3<f32>(.36,.88,.87)*sweep*.22;
let key=vec3<f32>(.99, .97+.03*uv.x, .93+.07*uv.y);
return vec4<f32>((world*(1.-host.a)+host.rgb*key)+air,1.);
