let map = textureSample(input0, linear_sampler, uv);
let t = frame.info.z * 0.28;
let phase = uv.y * 3.2 + map.r * 1.45 + 0.24 * sin(uv.x * 8.0 + t);
let band = pow(0.5 + 0.5 * cos(phase * 6.283185), 5.0);
let filament = pow(0.5 + 0.5 * cos(phase * 57.0 + map.b * 2.0), 12.0);
let night = mix(vec3<f32>(0.052, 0.032, 0.15), vec3<f32>(0.18, 0.075, 0.27), map.r);
let light = mix(vec3<f32>(0.68, 0.23, 0.92), vec3<f32>(0.22, 0.95, 0.71), smoothstep(0.18, 0.85, uv.x + 0.12 * sin(t)));
return vec4<f32>(night + light * (0.53 * band + 0.19 * filament), 1.0);
