let edge = vec4<f32>(local.y, extent.x-local.x, extent.y-local.y, local.x);
let dist = min(min(edge.x, edge.y), min(edge.z, edge.w));
var arc = local.x;
if (dist == edge.y) { arc = extent.x + local.y; }
else if (dist == edge.z) { arc = extent.x + extent.y + extent.x - local.x; }
else if (dist == edge.w) { arc = 2.0*extent.x + extent.y + extent.y - local.y; }
let loopT = arc / max(2.0 * (extent.x + extent.y), 1.0);
let crest = pow(0.5 + 0.5 * cos(6.2831853 * (loopT - phase)), 8.0);
let width = frame.params.z;
let depth = width * (0.45 + 2.8 * crest);
let ridge = 1.0 - smoothstep(0.0, max(0.8, width * 0.16), abs(dist - depth));
let glow = exp(-abs(dist-depth) / max(1.0, width));
let opacity = smoothstep(-0.5, 0.5, dist) * clamp(ridge * (0.23 + 0.70 * crest) + glow * (0.11 + 0.48 * crest), 0.0, 1.0);
let hue = 0.5 + 0.5 * cos(6.2831853 * (loopT + phase));
let pigment = mix(ink, glint, hue);
let surface = vec4<f32>(pigment * opacity, opacity) + base * (1.0 - opacity);
