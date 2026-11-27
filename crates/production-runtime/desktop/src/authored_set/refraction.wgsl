let inside = all(local >= vec2<f32>(0.0)) && all(local < extent);
var surface = base;
if (inside) {
    let direction = vec2<f32>(0.8, 0.6);
    let ridgeAngle = 6.2831853 * (dot(local, direction) / frame.params.w - phase);
    let slope = cos(ridgeAngle);
    let edge = min(local, extent - local);
    let feather = smoothstep(0.0, max(frame.params.z, 1.0), min(edge.x, edge.y));
    let offset = direction * (frame.params.z * slope * feather);
    let inset = min(extent * 0.5, vec2<f32>(0.5));
    let samplePx = origin + clamp(local + offset, inset, extent - inset);
    surface = textureSampleLevel(input0, linear_sampler, samplePx / frame.info.xy, 0.0);
}
