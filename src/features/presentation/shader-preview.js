// Trusted preview adapter for the same kernel used by the native GPU source.
function producerShaderPreview(canvas,config,width,height){
 const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:true});
 if(!gl){canvas.dataset.gpu='unavailable';return {draw(){},destroy(){}};}
 const mode=['aurora','edgeGlow','lightSweep','plasma','silk','rings','grid','stars','petals','contours','prism','borderFlare'].indexOf(config.effect),low=config.quality==='low',reduction=mode===0||(mode>=3&&mode<11)?(low?.25:.5):(low?.5:1);
 canvas.width=Math.max(1,Math.ceil(width*reduction));canvas.height=Math.max(1,Math.ceil(height*reduction));
 const compile=(type,code)=>{const s=gl.createShader(type);gl.shaderSource(s,code);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
 const vs=compile(gl.VERTEX_SHADER,'attribute vec2 point;varying vec2 uv;void main(){uv=vec2((point.x+1.0)*0.5,(1.0-point.y)*0.5);gl_Position=vec4(point,0.0,1.0);}');
 const fs=compile(gl.FRAGMENT_SHADER,'precision mediump float;varying vec2 uv;uniform float clockTime,effectType,speed,intensity,frequency,radius,alpha;uniform vec2 extent;uniform vec4 paletteA,paletteB,paletteC;\n'+PRODUCER_SHADER_KERNEL+'\nvoid main(){gl_FragColor=shade(uv);}');
 const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));gl.useProgram(program);
 const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
 const point=gl.getAttribLocation(program,'point');gl.enableVertexAttribArray(point);gl.vertexAttribPointer(point,2,gl.FLOAT,false,0,0);
 const params=Object.fromEntries(['clockTime','effectType','speed','intensity','frequency','radius','alpha','extent','paletteA','paletteB','paletteC'].map(k=>[k,gl.getUniformLocation(program,k)]));
 gl.uniform1f(params.effectType,mode);gl.uniform1f(params.speed,config.speed);gl.uniform1f(params.radius,config.radius);gl.uniform2f(params.extent,width,height);
 for(const[i,name]of ['paletteA','paletteB','paletteC'].entries()){const n=parseInt(config.colors[i].slice(1),16);gl.uniform4f(params[name],((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255,1);}
 canvas.dataset.gpu='webgl';canvas.dataset.effect=config.effect;let last='';
 return {draw(time,intensity=config.intensity,scale=config.scale,opacity=1,drawWidth=width,drawHeight=height){
  const t=Math.floor(time*30)/30,key=[t,intensity,scale,opacity,drawWidth,drawHeight].join(':');if(key===last)return;last=key;
  gl.useProgram(program);gl.uniform2f(params.extent,drawWidth,drawHeight);gl.viewport(0,0,canvas.width,canvas.height);gl.uniform1f(params.clockTime,t);gl.uniform1f(params.intensity,intensity);gl.uniform1f(params.frequency,scale);gl.uniform1f(params.alpha,opacity*config.opacity);gl.drawArrays(gl.TRIANGLES,0,6);
 },destroy(){gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);gl.getExtension('WEBGL_lose_context')?.loseContext();}};
}
