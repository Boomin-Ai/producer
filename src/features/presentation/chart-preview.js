/* Trusted rehearsal renderer for the native chart contract. No external code,
 * data fetches, animation loops, or accumulated history lives in this layer. */
function producerChartPreview(canvas,initial,w,h){
 const ctx=canvas.getContext('2d');const dpr=Math.min(2,devicePixelRatio||1);canvas.width=Math.ceil(w*dpr);canvas.height=Math.ceil(h*dpr);
 let target=initial,from=initial,start=-initial.durationMs,last=0,clock=0,lastInput;
 const advance=input=>{if(lastInput!==undefined)clock+=Math.max(0,input-lastInput);lastInput=input;return clock;};
 const mix=(a,b,p)=>a+(b-a)*p;
 const phase=time=>{const t=target.durationMs?Math.min(1,Math.max(0,(time-start)/target.durationMs)):1;return t*t*(3-2*t);};
 const sample=(data,x)=>{const points=data.points;if(!points.length||x<points[0].x||x>points[points.length-1].x)return null;let a=0,b=points.length-1;while(b>a+1){const m=(a+b)>>1;if(points[m].x<=x)a=m;else b=m;}if(points[a].x===x)return points[a].y;if(points[b].x===x)return points[b].y;if(points[a].y===null||points[b].y===null||points[b].x<=points[a].x)return null;return mix(points[a].y,points[b].y,(x-points[a].x)/(points[b].x-points[a].x));};
 const value=(x,p)=>{const a=sample(from.data,x),b=sample(target.data,x);return {y:a!==null&&b!==null?mix(a,b,p):b??a,alpha:a!==null&&b!==null?1:a!==null?1-p:b!==null?p:0};};
 function domain(time){const p=phase(time);return ['xMin','xMax','yMin','yMax'].map(k=>mix(from[k],target[k],p));}
 function draw(time){last=time;const p=phase(time),[xmin,xmax,ymin,ymax]=domain(time);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.save();ctx.beginPath();ctx.rect(0,0,w,h);ctx.clip();ctx.fillStyle=target.gridColor;for(let i=0;i<5;i++)ctx.fillRect(0,(h-1)*i/4,w,1);
  const py=y=>(1-Math.min(1,Math.max(0,(y-ymin)/(ymax-ymin))))*(h-2)+1;
  if(target.kind==='bar'){const bw=Math.max(1,w/Math.max(1,target.data.points.length)*.62);for(const point of target.data.points){const v=value(point.x,p);if(v.y===null)continue;const x=(point.x-xmin)/(xmax-xmin)*w,y=py(v.y);ctx.globalAlpha=v.alpha*.75;ctx.fillStyle=target.color;ctx.fillRect(x-bw/2,y,bw,h-1-y);}}
  else{let previous;for(let i=0;i<256;i++){const x=w*i/255,v=value(mix(xmin,xmax,i/255),p);if(v.y===null||v.alpha===0){previous=undefined;continue;}const y=py(v.y);if(previous){const alpha=Math.min(previous.alpha,v.alpha);if(target.kind==='area'){const gradient=ctx.createLinearGradient(0,Math.min(previous.y,y),0,h);gradient.addColorStop(0,target.color);gradient.addColorStop(1,'#00000000');ctx.globalAlpha=alpha*target.fillOpacity;ctx.fillStyle=gradient;ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(x,y);ctx.lineTo(x,h);ctx.lineTo(previous.x,h);ctx.fill();}ctx.globalAlpha=alpha;ctx.strokeStyle=target.color;ctx.lineWidth=target.lineWidth;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(previous.x,previous.y);ctx.lineTo(x,y);ctx.stroke();}previous={x,y,alpha:v.alpha};}}
  ctx.restore();ctx.globalAlpha=1;canvas.dataset.chartReady='true';
 }
 return {draw:input=>draw(advance(input)),update(next,input){const time=advance(input);if(next.data.scope!==target.data.scope){target=from=next;start=time-next.durationMs;draw(time);return;}const d=domain(last),p=phase(last),points=[];for(let i=0;i<256;i++){const x=mix(d[0],d[1],i/255),v=value(x,p);points.push({x,y:v.alpha>.01?v.y:null});}from={...target,xMin:d[0],xMax:d[1],yMin:d[2],yMax:d[3],data:{scope:target.data.scope,points}};target=next;start=time;draw(time);}};
}
