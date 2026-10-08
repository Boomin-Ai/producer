/* Trusted minimal renderer. This file is bundled as inert text into a sandboxed
 * opaque-origin frame. Imported packages never supply JavaScript or HTML. */
(() => {
  const canvas = document.getElementById('canvas');
  const style = document.getElementById('motion');
  let assets={};
  let width = 1280, height = 720, port, sequence = 0;
  let entries = new Map(),previousLayer;
  let timeline,motionReady=false;
  function removePrevious(){if(!previousLayer)return;for(const entry of previousLayer.entries.values()){entry.gpu?.destroy();entry.animation?.destroy();entry.element.querySelector('video')?.pause();}previousLayer.element.remove();previousLayer=null;}
  function sample(track,time){
    const frames=track.keyframes,last=frames[frames.length-1].atMs;time=Math.max(0,time-(track.delayMs||0));
    if(track.loop==='repeat')time%=last;else if(track.loop==='pingpong'){time%=last*2;if(time>last)time=last*2-time;}
    if(time>=last)return frames[frames.length-1].value;
    const i=frames.findIndex((f,i)=>i>0&&f.atMs>=time),a=frames[Math.max(0,i-1)],b=frames[i];let t=(time-a.atMs)/(b.atMs-a.atMs);
    if(track.easing==='easeIn')t*=t;else if(track.easing==='easeOut')t=1-(1-t)*(1-t);else if(!track.easing||track.easing==='easeInOut')t=t*t*(3-2*t);
    return a.value+(b.value-a.value)*t;
  }
  function animateTracks(map,tracks,show,segment){
      const transforms=new Map();
      for(const entry of map.values())if(entry.shader)entry.shaderValues={intensity:entry.shader.intensity,scale:entry.shader.scale,opacity:1};
      for(const track of tracks){const entry=map.get(track.target);if(!entry)continue;const value=sample(track,track.clock==='show'?show:segment),el=entry.element;
        if(track.property.startsWith('shader.')){if(entry.shaderValues)entry.shaderValues[track.property.slice(7)]=value;}
        else if(entry.shaderValues&&track.property==='opacity')entry.shaderValues.opacity=value;
        else if(track.property==='scale'||track.property==='rotation'){const t=transforms.get(el)||{scale:1,rotation:0};t[track.property]=value;transforms.set(el,t);}
        else el.style[({x:'left',y:'top'})[track.property]||track.property]=track.property==='opacity'?String(value):value+'px';
      }
      for(const [el,t]of transforms){el.style.transformOrigin='0 0';el.style.transform=(el.dataset.baseTransform||'')+' scale('+t.scale+') rotate('+t.rotation+'deg)';}
      for(const entry of map.values())if(entry.gpu){const v=entry.shaderValues;entry.gpu.draw((entry.shader.clock==='show'?show:segment)/1000,v.intensity,v.scale,v.opacity,parseFloat(entry.element.style.width),parseFloat(entry.element.style.height));}
  }
  function animate(){
    if(timeline&&motionReady){
      const c=timeline.clock,delta=c.running?Math.max(0,Date.now()-c.anchorMs):0,show=c.positionMs+delta,segment=c.segmentMs+delta;
      animateTracks(entries,timeline.tracks,show,segment);
      if(previousLayer){
        if(previousLayer.timeline)animateTracks(previousLayer.entries,previousLayer.timeline.tracks,show,Math.max(0,show-previousLayer.origin));
        if(previousLayer.running!==c.running){const now=Date.now();for(const entry of previousLayer.entries.values()){const t=entry.playback;if(!t)continue;if(!c.running){entry.resume=t.playing;if(t.playing)t.positionMs+=Math.max(0,now-t.anchorMs);t.playing=false;}else if(entry.resume)t.playing=true;t.anchorMs=now;transport(entry);}previousLayer.running=c.running;}
        const progress=Math.min(1,segment/previousLayer.duration);previousLayer.element.style.opacity=String(1-progress);if(progress>=1)removePrevious();
      }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  const px = new Set(['inset','left','top','right','bottom','width','height','gap','padding','fontSize','borderRadius','minHeight','maxWidth','wordSpacing']);
  function fit() {
    canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
    canvas.style.transform = 'scale(' + Math.min(innerWidth / width, innerHeight / height) + ')';
  }
  function transport(entry){
    const t=entry.playback;if(!t||entry.preparing)return;
    const elapsed=(t.positionMs+(t.playing?Math.max(0,Date.now()-t.anchorMs):0))/1000;
    const video=entry.element.querySelector('video');
    if(video&&Number.isFinite(video.duration)&&video.duration>0){
      // Let an in-flight seek finish. Re-seeking every clock tick can starve
      // decode when several off-air videos are preparing together.
      if(video.seeking){if(!t.playing)video.pause();return;}
      const target=entry.loop?elapsed%video.duration:Math.min(elapsed,video.duration);
      if(Math.abs(video.currentTime-target)>.2)video.currentTime=target;
      if(t.playing&& (entry.loop||elapsed<video.duration)){if(video.paused)video.play().catch(()=>{});}else video.pause();
    }
    if(entry.animation?.isLoaded){
      const a=entry.animation,duration=a.getDuration(false),target=entry.loop?elapsed%duration:Math.min(elapsed,duration);
      // The shared clock drives Lottie directly, avoiding independent canvas clocks.
      const frame=Math.min(a.totalFrames-1,Math.floor(target*a.frameRate));if(entry.lastFrame!==frame){a.goToAndStop(frame,true);entry.lastFrame=frame;}
    }
  }
  setInterval(()=>{for(const entry of entries.values())transport(entry);},33);
  function mediaReady(entry){
    const video=entry.element.querySelector('video'),image=entry.element.querySelector('img'),animation=entry.animation;
    if(video&&video.readyState>=2&&!video.seeking||image&&image.complete&&image.naturalWidth>0||animation?.isLoaded||!video&&!image&&!animation)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(false),4000);
      function finish(ok){clearTimeout(timer);video?.removeEventListener('loadeddata',ready);video?.removeEventListener('seeked',ready);video?.removeEventListener('error',failed);image?.removeEventListener('load',ready);image?.removeEventListener('error',failed);animation?.removeEventListener('DOMLoaded',ready);ok?resolve():reject(new Error('Media did not decode'));}
      function ready(){if(video&&(video.seeking||video.readyState<2))return;finish(true);}function failed(){finish(false);}
      video?.addEventListener('loadeddata',ready);video?.addEventListener('seeked',ready);video?.addEventListener('error',failed,{once:true});image?.addEventListener('load',ready,{once:true});image?.addEventListener('error',failed,{once:true});animation?.addEventListener('DOMLoaded',ready);
    });
  }
  function sync(node, parent, used, surface, isRoot = false) {
    used.add(node.id);
    let entry = entries.get(node.id);
    if (!entry || entry.type !== node.type) {
      if (entry){entry.gpu?.destroy();entry.animation?.destroy();entry.element.remove();}
      const el = document.createElement('div');
      el.dataset.node = node.id; entry = { element: el, type: node.type }; entries.set(node.id, entry);
    }
    const el = entry.element;
    entry.appearance = node.appearance; entry.framing=node.framing;
    el.removeAttribute('style');
    for (const [key, value] of Object.entries(node.styles)) el.style[key] = typeof value === 'number' && px.has(key) ? value + 'px' : String(value);
    el.dataset.baseTransform=el.style.transform;
    // Experimental two-layer native proof: root backdrop below media, remaining
    // graphics above it. General interleaved layers/masks are not implemented.
    if (surface === 'foreground' && isRoot) el.style.background = 'transparent';
    if (surface === 'background' && !isRoot) el.style.visibility = 'hidden';
    el.className = [node.type === 'slot' ? 'slot' : '', node.motionClass || ''].filter(Boolean).join(' ');
    if (node.type === 'text') el.textContent = node.text;
    if(node.type==='shader'){
      entry.shader=node.shader;
      if(surface==='preview'){
        const signature=JSON.stringify([node.shader,node.styles.width,node.styles.height]);
        if(entry.shaderSignature!==signature){entry.gpu?.destroy();el.replaceChildren();const gpu=document.createElement('canvas');gpu.style.cssText='width:100%;height:100%;display:block';el.appendChild(gpu);entry.gpu=producerShaderPreview(gpu,node.shader,node.styles.width,node.styles.height);entry.shaderSignature=signature;entry.gpu.draw(0);}
      }else el.style.visibility='hidden';
    }
    if(node.type==='media'&&surface!=='background'){
      entry.preparing=true;
      const asset=assets[node.assetId];
      if(!asset)throw new Error('Missing media asset');
      const signature=JSON.stringify([node.assetId]);
      if(entry.mediaSignature!==signature||entry.assetData!==asset.data){
        entry.animation?.destroy();entry.animation=null;entry.lastFrame=undefined;el.replaceChildren();entry.mediaSignature=signature;entry.assetData=asset.data;
        el.style.overflow='hidden';
        if(asset.mime==='application/lottie+json'){
          const raw=atob(asset.data.split(',')[1]);const animationData=JSON.parse(new TextDecoder().decode(Uint8Array.from(raw,c=>c.charCodeAt(0))));
          entry.animation=lottie.loadAnimation({container:el,renderer:'svg',animationData,loop:node.loop,autoplay:node.autoplay,rendererSettings:{preserveAspectRatio:node.fit==='cover'?'xMidYMid slice':'xMidYMid meet'}});
        }else{
          const media=document.createElement(asset.mime.startsWith('video/')?'video':'img');media.src=asset.data;media.style.cssText='width:100%;height:100%;display:block;';media.style.objectFit=node.fit;
          if(media.tagName==='VIDEO'){media.muted=true;media.loop=node.loop;media.autoplay=node.playback?false:node.autoplay;media.playsInline=true;media.preload='auto';}
          else media.alt=asset.name;
          media.addEventListener('error',()=>{el.textContent='Unable to load '+asset.name;el.style.color='#ffb5b5';});el.appendChild(media);
        }
      }
      const visual=el.querySelector('video,img');if(visual)visual.style.objectFit=node.fit;const svg=el.querySelector('svg');if(svg)svg.setAttribute('preserveAspectRatio',node.fit==='cover'?'xMidYMid slice':'xMidYMid meet');const video=el.querySelector('video');if(video)video.loop=node.loop;
      entry.playback=node.playback;entry.loop=node.loop;transport(entry);
      el.style.overflow='hidden';
    }
    if (node.type === 'slot') {
      el.dataset.slot = node.slotId;
      el.textContent = '';
      el.setAttribute('aria-label', node.slotLabel + (surface === 'preview' ? ' simulated source' : ' source slot'));
      el.style.background = 'transparent';
      entry.previewShape = null;
      if (node.appearance && surface === 'preview') {
        const a = node.appearance;
        // Keep the placement box unchanged. A circle is inscribed in that box,
        // matching the native mask rather than stretching into an ellipse.
        if (!el.style.position) el.style.position = 'relative';
        const shape = document.createElement('div');
        shape.style.cssText = 'position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;';
        shape.style.borderRadius = a.shape === 'circle' ? '50%' : a.cornerRadius + 'px';
        shape.style.border = a.outlineWidth + 'px solid ' + a.outlineColor;
        shape.style.opacity = a.opacity;
        const fill = document.createElement('div');
        fill.style.cssText = 'position:absolute;inset:0;background:linear-gradient(135deg,#292738,#403748);';
        fill.style.filter = 'grayscale(' + a.grayscale + ')';
        const label = document.createElement('span');
        label.style.position = 'relative';
        label.textContent = node.slotLabel + ' · simulated source';
        shape.append(fill, label); el.appendChild(shape); entry.previewShape = shape;
        if (a.shape === 'circle') {
          shape.style.left = '50%'; shape.style.top = '50%'; shape.style.transform = 'translate(-50%,-50%)';
        } else shape.style.inset = '0';
      }
    }
    if (el.parentNode !== parent) parent.appendChild(el);
    // append also establishes declared order when an existing keyed child moves.
    for (const child of node.children) { sync(child, el, used, surface); el.appendChild(entries.get(child.id).element); }
  }
  addEventListener('message', event => {
    if (event.source !== parent) return;
    if (event.data === 'presentation.probe') { parent.postMessage('presentation.ready', '*'); return; }
    if (event.data !== 'presentation.connect' || event.ports.length !== 1) return;
    if (port) port.close();
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (!data || data.type !== 'output' || !data.projection) return;
      try {
        if(data.transportOnly){
          timeline=data.projection.timeline;
          const apply=node=>{const entry=entries.get(node.id);if(entry&&node.type==='media'){entry.playback=node.playback;entry.loop=node.loop;const video=entry.element.querySelector('video');if(video){video.loop=node.loop;if(!node.playback){if(node.autoplay)video.play().catch(()=>{});else video.pause();}}transport(entry);}node.children.forEach(apply);};
          apply(data.projection.root);return;
        }
        const p = data.projection,outgoingTimeline=timeline;timeline=p.timeline;motionReady=false;assets={...assets,...(p.assets||{})}; if(Array.isArray(data.assetIds))for(const id of Object.keys(assets))if(!data.assetIds.includes(id))delete assets[id];width = p.width; height = p.height;
        const surface = ['background', 'foreground'].includes(data.surface) ? data.surface : 'preview';
        if(!p.timeline||!p.timeline.clock.running&&p.timeline.clock.positionMs===0)removePrevious();
        if(surface==='preview'&&p.timeline?.clock.running&&p.timeline?.transition?.type==='crossfade'&&p.timeline.transition.durationMs>0&&canvas.firstElementChild?.dataset.node!==p.root.id&&entries.size){
          removePrevious();const overlay=document.createElement('div');overlay.dataset.transition='crossfade';overlay.style.cssText='position:absolute;inset:0;pointer-events:none;z-index:1000';for(const child of [...canvas.children])overlay.appendChild(child);
          previousLayer={element:overlay,entries,timeline:outgoingTimeline,origin:outgoingTimeline?outgoingTimeline.clock.positionMs-outgoingTimeline.clock.segmentMs:0,running:p.timeline.clock.running,duration:p.timeline.transition.durationMs};entries=new Map();canvas.appendChild(overlay);
        }
        const ticket = ++sequence;
        const used = new Set(); sync(p.root, canvas, used, surface, true);
        if(previousLayer)canvas.appendChild(previousLayer.element);
        for (const [id, entry] of entries) if (!used.has(id)) { entry.gpu?.destroy();entry.animation?.destroy();entry.element.querySelector('video')?.pause();entry.element.remove(); entries.delete(id); }
        if (style.textContent !== p.css) style.textContent = p.css;
        fit(); port.postMessage({ type: 'rendered', revision: p.revision });
        // Measure synchronously after decode. Offscreen rAF can be throttled; the
        // native revision beacon verifies GPU paint independently. Geometry
        // is a preparation receipt, not proof that OBS has presented
        // this revision. Native readback must still verify its own pixels.
        Promise.all([...entries.values()].filter(e=>used.has(e.element.dataset.node)&&e.type==='media').map(async entry=>{await mediaReady(entry);if(ticket!==sequence)return;entry.preparing=false;transport(entry);await mediaReady(entry);})).then(() => {
          if (ticket !== sequence || !port) return;
          const bounds = canvas.getBoundingClientRect(), scale = bounds.width / width;
          if (!(scale > 0)) return;
          for (const e of entries.values()) if (e.previewShape && e.appearance.shape === 'circle') {
            const r = e.element.getBoundingClientRect();
            const size = Math.min(r.width, r.height) / scale;
            e.previewShape.style.width = size + 'px'; e.previewShape.style.height = size + 'px';
          }
          const slots = [...entries.values()].filter(e => e.type === 'slot').map(e => {
            const r = e.element.getBoundingClientRect();
            return { nodeId: e.element.dataset.node, slotId: e.element.dataset.slot,
              x: (r.x - bounds.x) / scale, y: (r.y - bounds.y) / scale,
              width: r.width / scale, height: r.height / scale, ...(e.framing ? { framing:e.framing } : {}), ...(e.appearance ? { appearance: e.appearance } : {}) };
          });
          if(surface!=='preview'){
            let beacon=document.getElementById('native-paint');if(!beacon){beacon=document.createElement('div');beacon.id='native-paint';beacon.setAttribute('aria-hidden','true');document.body.appendChild(beacon);}
            const serial=data.serial??0,a=32+serial%190,b=32+Math.floor(serial/190)%190;
            // This beacon shares the design's document and compositor. A parent
            // frame beacon could paint ahead of the child's changed graphics.
            beacon.style.cssText='position:absolute;left:'+width+'px;top:0;width:2px;height:1px;pointer-events:none;background:linear-gradient(to right,rgb('+[a,a,a].join(',')+') 50%,rgb('+[b,b,b].join(',')+') 50%)';
          }
          port.postMessage({ type: 'prepared', revision: p.revision, serial:data.serial??0, width, height, slots });
          motionReady=true;
        }).catch(()=>{if(ticket===sequence&&port)port.postMessage({type:'error'});});
      } catch { port.postMessage({ type: 'error' }); }
    };
    port.start(); port.postMessage({ type: 'connected' });
  });
  new ResizeObserver(fit).observe(document.body);
  parent.postMessage('presentation.ready', '*');
})();
