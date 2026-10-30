// Shared, trusted kernel for WebGL preview and native OBS/Metal output.
// No imported code, texture sampling loops, or blur passes.
// Bounded periodic contours; every style closes at the angular seam.
float voiceWave(float a,float t,float h,float style) {
 if(style<0.5)return 0.5+0.25*sin(a*h-t*1.8)+0.15*sin(a*(h+2.0)+t*1.2)+0.1*sin(a*(h+4.0)-t*0.9);
 if(style<1.5)return 0.5+0.35*sin(a*3.0-t*1.4)*cos(a*2.0+t*0.7);
 if(style<2.5)return pow(0.5+0.5*sin(a*18.0-t*2.0),3.0)*(0.65+0.35*sin(a*3.0+t));
 if(style<3.5)return 0.5+0.3*sin(a*2.0-t)+0.18*sin(a*3.0+t*0.6);
 if(style<4.5)return 0.45+0.35*cos(a*4.0-t*0.8)+0.18*sin(a*2.0+t*1.3);
 if(style<5.5)return 0.5+0.25*sin(a*3.0+t)+0.2*sin(a*6.0-t*1.6);
 if(style<6.5)return 0.5+0.4*sin(a*2.0-t)*cos(a*3.0+t*0.5);
 if(style<7.5)return 0.5+0.4*sin(a*7.0-t*2.0);
 if(style<8.5)return pow(0.5+0.5*cos(a*8.0-t*0.6),0.65);
 if(style<9.5)return 0.2+0.65*pow(0.5+0.5*sin(a*13.0+t*2.0),6.0)+0.1*sin(a*3.0-t);
 if(style<10.5)return 0.5+0.12*sin(a*2.0-t)+0.1*sin(a*11.0+t*0.5);
 if(style<11.5)return 0.5+0.45*cos(a*2.0-t*0.7);
 if(style<12.5){float pulse=exp(-pow(sin((a-t)*0.5)*7.0,2.0));return 0.25+pulse*(0.45+0.3*sin(a*16.0-t*16.0));}
 if(style<13.5)return 0.5+0.2*sin(a*3.0-t*0.4)+0.15*cos(a*5.0+t*0.3)+0.12*sin(a*9.0-t*0.7);
 return 0.5+0.3*cos(a*3.0-t)+0.18*cos(a*6.0-t*2.0);
}
vec4 shade(vec2 uv) {
 float t=clockTime*speed;
 vec3 a=paletteA.xyz,b=paletteB.xyz,c=paletteC.xyz;
 // One closed contour; integer angular harmonics keep the seam connected.
 if(effectType>15.5) {
  vec2 p=(uv-0.5)*extent;
  float radial=length(p),limit=min(extent.x,extent.y)*0.5;
  float inner=min(radius,max(1.0,limit-12.0));
  float level=clamp(audioLevel*intensity,0.0,1.0);
  float harmonic=clamp(floor(frequency*3.0+0.5),1.0,8.0);
  float angle=atan(p.y,p.x);
  float style=voiceStyle>14.5?0.0:floor(voiceStyle+0.5);
  float wave=clamp(voiceWave(angle,t,harmonic,style),0.0,1.0);
  float amplitude=level*max(0.0,limit-inner-36.0)*0.95;
  float contour=inner+11.0+amplitude*wave;
  float slope=amplitude*(voiceWave(angle+0.01,t,harmonic,style)-voiceWave(angle-0.01,t,harmonic,style))/0.02;
  float thickness=8.0+level*6.0;
  if(style>12.5&&style<13.5)thickness=10.0+level*13.0;
  if(style>9.5&&style<10.5)thickness=2.5+level*2.0;
  if(style>0.5&&style<1.5||style>5.5&&style<7.5)thickness=4.0+level*3.0;
  float distance=abs(radial-contour)/sqrt(1.0+pow(slope/max(contour,1.0),2.0))-thickness;
  // Multiple currents remain connected contours with the same camera center.
  if(style>0.5&&style<1.5||style>5.5&&style<7.5){
   float twin=inner+13.0+amplitude*clamp(voiceWave(angle,t+2.1,harmonic,style),0.0,1.0);
   distance=min(distance,abs(radial-twin)-thickness*0.75);
  }
  if(style>4.5&&style<5.5||style>9.5&&style<10.5||style>13.5){
   float ripple=inner+8.0+amplitude*wave*0.48;
   distance=min(distance,abs(radial-ripple)-2.5-level*1.5);
   distance=min(distance,abs(radial-(inner+6.0+amplitude*wave*0.22))-1.5-level);
  }
  if(style>2.5&&style<3.5||style>10.5&&style<11.5){
   float orbit=inner+10.0+amplitude*(0.5+0.45*cos(angle*2.0+t));
   distance=min(distance,abs(radial-orbit)-2.0-level*2.0);
  }
  if(voiceStyle>14.5)distance=radial-contour-thickness;
  float core=1.0-smoothstep(-0.75,0.75,distance);
  float bloom=exp(-max(distance,0.0)/5.0)*clamp(glow,0.0,1.0)*level*0.9;
  float coverage=clamp(core+(1.0-core)*bloom,0.0,1.0)*alpha*(voiceStyle>14.5?1.0:smoothstep(inner-2.0,inner,radial));
  vec3 color=mix(a,mix(b,c,0.5+0.5*sin(angle-t*level*0.35)),0.85+level*0.15);
  return vec4(color*coverage,coverage);
 }
 // Voice level visualization: one analytical bar lookup, never a PCM/spectrum claim.
 // Native audioLevel comes from the existing microphone bus; no device activation.
 if(effectType>14.5) {
  float level=clamp(audioLevel*intensity,0.0,1.0);
  float count=clamp(floor(extent.x/max(extent.y,1.0)*frequency*8.0),8.0,96.0);
  float cellWidth=extent.x/count,index=floor(uv.x*count);
  float seed=fract(sin(index*12.9898+17.13)*4375.8545);
  float shape=0.42+0.34*sin(index*0.73+t*2.1)+0.24*sin(index*1.37-t*1.4+seed*6.28);
  float halfWidth=cellWidth*0.32;
  float halfHeight=min(extent.y*0.48,1.0+level*extent.y*(0.18+0.28*clamp(shape,0.0,1.0)));
  float barRadius=min(min(halfWidth,halfHeight),radius);
  vec2 q=vec2(abs(fract(uv.x*count)-0.5)*cellWidth,abs(uv.y-0.5)*extent.y)-vec2(halfWidth-barRadius,halfHeight-barRadius);
  float distance=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0)-barRadius;
  float core=1.0-smoothstep(-0.75,0.75,distance);
  float bloom=exp(-max(distance,0.0)/max(1.0,cellWidth*0.22))*clamp(glow,0.0,1.0)*level*0.7;
  float coverage=clamp(core+(1.0-core)*bloom,0.0,1.0)*alpha;
  vec3 color=mix(a,mix(b,c,uv.x),0.55+level*0.45);
  return vec4(color*coverage,coverage);
 }
 // Bounded weather layers. One analytical cell lookup; transparent background.
 if(effectType>11.5) {
  vec2 p=uv*vec2(extent.x/extent.y,1.0);
  float light=0.0;
  if(effectType<12.5) { // Slanted rain streaks, independently hashed per cell.
   vec2 q=vec2((p.x+p.y*0.19)*frequency*55.0,(p.y-t*0.55)*frequency*15.0);
   vec2 seed=floor(q),f=fract(q);
   float hash=fract(sin(dot(seed,vec2(12.9898,78.233)))*4375.8545);
   float streak=exp(-pow((f.x-(0.15+hash*0.7))*45.0,2.0));
   light=streak*smoothstep(0.0,0.16,f.y)*(1.0-smoothstep(0.55,0.95,f.y))*step(0.32,hash);
  } else if(effectType<13.5) { // Drifting snow, soft circular flakes.
   vec2 q=vec2((p.x+sin(t*0.2+p.y*3.0)*0.018)*frequency*22.0,(p.y-t*0.09)*frequency*22.0);
   vec2 seed=floor(q),f=fract(q);
   float hash=fract(sin(dot(seed,vec2(12.9898,78.233)))*4375.8545);
   vec2 center=vec2(0.15+hash*0.7,0.15+fract(hash*7.3)*0.7);
   float d=length(f-center);
   light=exp(-d*d*(180.0+hash*280.0))*step(0.25,hash);
  } else { // Slowly drifting cloud veil, intentionally no opaque fill.
   float field=sin(p.x*frequency*4.0+t*0.08)+sin(p.y*frequency*6.0-t*0.04)+sin((p.x+p.y)*frequency*3.0+t*0.06);
   light=smoothstep(-0.5,2.7,field)*0.55;
  }
  light=clamp(light*intensity,0.0,1.0)*alpha;
  return vec4(mix(b,c,0.35)*light,light);
 }
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
  float edgeLight=clamp(edge*pulse*intensity,0.0,1.0)*alpha*coverage;
  return vec4(col*edgeLight,edgeLight);
 }
 float phase=fract(t*0.16);
 float band=exp(-pow((uv.x+uv.y*0.22-(phase*1.6-0.3))*max(2.0,frequency*12.0),2.0));
 float light=clamp(band*intensity,0.0,1.0)*alpha*coverage;
 return vec4(mix(b,c,uv.y)*light,light);
}
