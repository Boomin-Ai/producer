let photo=textureSample(input0,linear_sampler,uv).rgb;
// Windows retain their own light while brick and stone pick up local scene lighting.
let warm=max(photo.r-photo.b,0.);
let luma=dot(photo,vec3<f32>(.23,.66,.11));
let powered=smoothstep(.30,.74,luma+warm*.55);
let stone=mix(photo*vec3<f32>(.84,.88,.99),photo,powered);
return vec4<f32>(stone,.72+.28*powered);
