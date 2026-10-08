// Shared, trusted kernel for WebGL preview and native OBS/Metal output.
// No imported code, texture sampling loops, or blur passes.
vec4 shade(vec2 uv) {
 float t=clockTime*speed;
 vec3 a=paletteA.xyz,b=paletteB.xyz,c=paletteC.xyz;
 // Hairline perimeter flare: bright moving head, short falloff, no filled panel.
 if(effectType>10.5) {
  vec2 halfSize=extent*0.5,p=(uv-0.5)*extent;
  float r=min(radius,min(halfSize.x,halfSize.y));
  vec2 q=abs(p)-(halfSize-r-vec2(2.0));
  float d=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0)-r;
  float angle=atan(p.y,p.x)/6.2831853+0.5;
  float distance=fract(angle-t*0.12);
  float ahead=min(distance,1.0-distance);
  float head=exp(-pow(ahead*70.0,2.0));
  float trail=exp(-distance*30.0);
  float line=exp(-pow((d+0.35)/0.65,2.0));
  float halo=exp(-abs(d+0.35)/2.5);
  float light=clamp((line*(0.055+trail*0.75+head)+halo*head*0.24)*intensity,0.0,1.0)*alpha;
  vec3 col=mix(b,c,clamp(head+trail*0.2,0.0,1.0));
  return vec4(col*light,light);
 }
 if(effectType>2.5) {
  vec2 p=(uv-0.5)*vec2(extent.x/extent.y,1.0);
  float f=frequency,v=0.0,accent=0.0;
  if(effectType<3.5) { // Liquid plasma: three interfering fields.
   v=0.5+0.24*sin(p.x*f*7.0+t*0.6)+0.2*sin(p.y*f*9.0-t*0.4);
   accent=0.5+0.5*sin((p.x+p.y)*f*5.0+v*4.0+t*0.3);
  } else if(effectType<4.5) { // Silk ribbons.
   float wave=p.y+sin(p.x*f*4.0+t*0.35)*0.16;
   v=0.5+0.5*sin(wave*f*20.0-t*0.6);
   accent=pow(v,4.0);
  } else if(effectType<5.5) { // Concentric pulse.
   float dist=length(p+vec2(0.12*sin(t*0.2),0.08*cos(t*0.3)));
   v=pow(0.5+0.5*cos(dist*f*26.0-t),5.0)*exp(-dist*1.5);
   accent=0.5+0.5*sin(dist*7.0+t*0.3);
  } else if(effectType<6.5) { // Moving architectural grid.
   vec2 cell=abs(fract((p+vec2(t*0.025,-t*0.02))*f*8.0)-0.5);
   v=exp(-min(cell.x,cell.y)*48.0);
   accent=0.5+0.5*sin(p.x*4.0+p.y*6.0-t);
  } else if(effectType<7.5) { // Procedural star field, one cell lookup.
   vec2 cell=(p+vec2(t*0.012,t*0.008))*f*18.0;
   vec2 seed=floor(cell);
   float hash=fract(sin(dot(seed,vec2(12.9898,78.233)))*4375.8545);
   vec2 center=vec2(0.2+hash*0.6,0.2+fract(hash*7.3)*0.6);
   float dotSize=length(fract(cell)-center);
   v=exp(-dotSize*dotSize*280.0)*step(0.65,hash)*(0.65+0.35*sin(t+hash*18.0));
   accent=hash;
  } else if(effectType<8.5) { // Kaleidoscopic petals.
   float angle=atan(p.y,p.x),dist=length(p);
   float petal=dist+0.13*sin(angle*6.0+t*0.4);
   v=0.5+0.5*cos(petal*f*22.0-t*0.7);
   accent=0.5+0.5*sin(angle*3.0-t*0.2);
  } else if(effectType<9.5) { // Contour map.
   float terrain=sin(p.x*f*3.0+t*0.2)+cos(p.y*f*4.0-t*0.15)+sin((p.x+p.y)*f*2.0);
   v=exp(-abs(fract(terrain*2.0)-0.5)*30.0);
   accent=0.5+0.5*sin(terrain+t*0.2);
  } else { // Prismatic diagonals.
   float stripe=fract((p.x+p.y*0.65)*f*4.0-t*0.1);
   v=0.5+0.5*cos(stripe*6.28318);
   accent=clamp(uv.y+0.2*sin(t*0.3),0.0,1.0);
  }
  vec3 col=mix(a,mix(b,c,accent),clamp(v*intensity,0.0,1.0));
  return vec4(col*alpha,alpha);
 }
 if(effectType<0.5) {
  vec2 p=uv*vec2(extent.x/extent.y,1.0);
  float w=sin(p.x*frequency*2.7+t*0.42)+sin(p.y*frequency*3.1-p.x*1.3-t*0.31);
  float ribbon=exp(-pow((uv.y-0.48)*3.2+w*0.48,2.0));
  float mist=0.5+0.5*sin(p.x*frequency*1.8+p.y*2.0+t*0.23);
  vec3 col=mix(a,b,clamp(ribbon*intensity,0.0,1.0));
  col=mix(col,c,clamp(ribbon*mist*intensity*0.45,0.0,0.7));
  return vec4(col*alpha,alpha);
 }
 vec2 halfSize=extent*0.5,p=(uv-0.5)*extent;
 float r=min(radius,min(halfSize.x,halfSize.y));
 vec2 q=abs(p)-(halfSize-r-vec2(2.0));
 float d=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0)-r;
 float coverage=clamp(0.5-d,0.0,1.0);
 if(effectType<1.5) {
  float edge=exp(-abs(d+3.0)/max(1.0,frequency*5.0));
  float pulse=0.65+0.35*sin(t*1.7+uv.x*5.0-uv.y*4.0);
  vec3 col=mix(b,c,0.5+0.5*sin(t*0.7+uv.x*4.0+uv.y*2.0));
  float glow=clamp(edge*pulse*intensity,0.0,1.0)*alpha*coverage;
  return vec4(col*glow,glow);
 }
 float phase=fract(t*0.16);
 float band=exp(-pow((uv.x+uv.y*0.22-(phase*1.6-0.3))*max(2.0,frequency*12.0),2.0));
 float light=clamp(band*intensity,0.0,1.0)*alpha*coverage;
 return vec4(mix(b,c,uv.y)*light,light);
}
