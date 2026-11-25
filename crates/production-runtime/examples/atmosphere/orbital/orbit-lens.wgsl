let t=frame.info.z;
let aspect=frame.info.x/frame.info.y;
let portrait=aspect<1.0;
let center=select(vec2<f32>(0.61,0.392),vec2<f32>(0.53,0.346),portrait);
let radius=select(0.267,0.144,portrait);
