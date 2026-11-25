let field=textureSample(input0,linear_sampler,uv).rgb;
let letters=textureSample(input1,linear_sampler,uv);
return vec4<f32>(field*(1.-letters.a)+letters.rgb,1.);
