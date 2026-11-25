let t=frame.info.z;
let aspect=frame.info.x/frame.info.y;
let portrait=aspect<1.0;
let center=select(vec2<f32>(0.19,0.85),vec2<f32>(0.24,0.51),portrait);
let radius=select(0.66,0.34,portrait);
