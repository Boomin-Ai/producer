//! Debug-only isolated native acceptance probe. No capture devices unless the
//! explicit camera-check marker is present. No guest links,
//! destinations, recording, microphone, room document or server connection.
use super::{engine::{Command, LiveHandle}, ffi, graph::{SceneGraph,ExtraSpec}};
use std::{sync::{Mutex,mpsc,atomic::{AtomicBool,Ordering}}, time::Duration};
static PIXELS:Mutex<Vec<u8>>=Mutex::new(Vec::new());
static REQUEST_FRAME:AtomicBool=AtomicBool::new(false);
extern "C" fn frame(_: *mut std::ffi::c_void, data:*mut ffi::video_data) {
    if !REQUEST_FRAME.swap(false,Ordering::SeqCst){return;}
    unsafe {if data.is_null() || (*data).data[0].is_null(){return;}
      let mut out=Vec::with_capacity(1280*720*4);
      for y in 0..720 {out.extend_from_slice(std::slice::from_raw_parts((*data).data[0].add(y*(*data).linesize[0] as usize),1280*4));}
      *PIXELS.lock().unwrap()=out;
    }
}
fn capture(path:&std::path::Path,name:&str)->Result<Vec<u8>,String> {
    PIXELS.lock().unwrap().clear();REQUEST_FRAME.store(true,Ordering::SeqCst);
    for _ in 0..100 {std::thread::sleep(Duration::from_millis(20));let p=PIXELS.lock().unwrap();if !p.is_empty(){std::fs::write(path.join(format!("{name}.bgra")),&*p).map_err(|e|e.to_string())?;return Ok(p.clone());}}
    Err("Native frame capture timed out".into())
}
fn pixel(frame:&[u8],x:usize,y:usize)->(u8,u8,u8){let i=(y*1280+x)*4;(frame[i+2],frame[i+1],frame[i])}
pub unsafe fn start(graph:&mut SceneGraph,handle:LiveHandle,path:std::path::PathBuf)->Result<(),String> {
    if !graph.state().items.is_empty(){return Err("Probe requires an isolated empty graph".into());}
    if path.join("camera-check").exists() {
        let mut sizes=Vec::new();
        for _ in 0..3 {
            graph.add_extra("camera-check","Camera startup check",&ExtraSpec::Camera{device:None})?;
            let src=graph.source_by_id("camera-check").ok_or("Missing camera source")?;
            let mut size=(0,0);
            for _ in 0..250 {
                std::thread::sleep(Duration::from_millis(20));
                size=(ffi::obs_source_get_width(src),ffi::obs_source_get_height(src));
                if size.0>0 && size.1>0 {break;}
            }
            graph.remove_extra("camera-check")?;
            if size.0==0 || size.1==0 {return Err("Camera did not deliver a frame within five seconds".into());}
            sizes.push(size);
            std::thread::sleep(Duration::from_millis(400));
        }
        std::fs::write(path.join("result.json"),serde_json::json!({"ok":true,"cameraStarts":sizes}).to_string()).map_err(|e|e.to_string())?;
        return Ok(());
    }
    graph.add_extra("set-probe-host","Synthetic host",&ExtraSpec::Color{color:"#20c060".into()})?;
    graph.add_extra("set-probe-guest","Synthetic guest",&ExtraSpec::Color{color:"#f08030".into()})?;
    if path.join("output-routing-check").exists(){
      std::thread::spawn(move||{
        let result=(||->Result<serde_json::Value,String>{
          handle.portrait_room()?;handle.select_output(true)?;
          if path.join("virtualcam-check").exists(){
            handle.portrait_transform("set-probe-host".into(),super::graph::TransformPatch{x:Some(0.),y:Some(0.),w:Some(180.),h:Some(1280.),..Default::default()})?;
            handle.portrait_transform("set-probe-guest".into(),super::graph::TransformPatch{x:Some(540.),y:Some(0.),w:Some(180.),h:Some(1280.),..Default::default()})?;
            handle.set_virtual_cam(true)?;
            super::portrait::want_program(true);
            std::fs::write(path.join("virtualcam-ready"),"portrait").map_err(|e|e.to_string())?;
            for _ in 0..1800{let jpeg=super::portrait::program_frame();if !jpeg.is_empty(){std::fs::write(path.join("program.jpg"),jpeg).map_err(|e|e.to_string())?;}if path.join("virtualcam-observed").exists(){break;}std::thread::sleep(Duration::from_millis(100));}
            super::portrait::want_program(false);
            handle.set_virtual_cam(false)?;
          }
          let portrait=handle.start_recording_mode("Selected portrait acceptance".into(),false)?;
          if handle.select_output(false).is_ok(){return Err("Canvas changed during recording".into());}
          std::thread::sleep(Duration::from_secs(3));handle.stop_recording()?;
          handle.select_output(false)?;
          let landscape=handle.start_recording_mode("Selected landscape acceptance".into(),false)?;
          std::thread::sleep(Duration::from_secs(3));handle.stop_recording()?;
          Ok(serde_json::json!({"ok":true,"portrait":portrait,"landscape":landscape,"recordingSwitchBlocked":true}))
        })();let report=result.unwrap_or_else(|e|serde_json::json!({"ok":false,"error":e}));let _=std::fs::write(path.join("result.json"),report.to_string());
      });return Ok(());
    }
    if path.join("framing-check").exists() {
      let data=ffi::obs_data_create_from_json(std::ffi::CString::new("{\"width\":960,\"height\":720,\"color\":4280336480}").unwrap().as_ptr());
      ffi::obs_source_update(graph.source_by_id("set-probe-host").unwrap(),data);ffi::obs_data_release(data);
    }

    #[repr(C)]struct Scale {format:i32,width:u32,height:u32,range:i32,colorspace:i32}
    let scale=Scale{format:7,width:1280,height:720,range:2,colorspace:2};
    ffi::obs_add_raw_video_callback(&scale as *const _ as *const _,frame,std::ptr::null_mut());
    std::thread::spawn(move || {
      let test=(||->Result<serde_json::Value,String>{
        let projections:Vec<super::presentation::Projection>=serde_json::from_slice(&std::fs::read(path.join("projections.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        let status=handle.presentation_status()?;let lease=uuid::Uuid::new_v4().to_string();
        std::thread::sleep(Duration::from_millis(600));
        let baseline=serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?;
        let before=capture(&path,"room-before")?;
        if path.join("morph-check").exists(){
          use super::presentation::Request;
          let bindings:std::collections::HashMap<String,String>=std::collections::HashMap::from([("host".into(),"set-probe-host".into()),("content".into(),"set-probe-guest".into())]);let mut samples=Vec::new();
          for(index,mut p)in projections.into_iter().enumerate(){
            p.revision=index as u64+1;if let Some(t)=p.timeline.as_mut(){t.clock.running=false;t.clock.anchor_ms=super::animation::utc_ms();}
            let camera=p.root.children.iter().find(|n|n.slot_id.as_deref()==Some("host")).ok_or("No host slot")?;
            let property=|key:&str,style:&str|{let base=camera.styles[style].as_f64().unwrap();p.timeline.as_ref().and_then(|t|t.tracks.iter().find(|track|track.target==camera.id&&track.property==key).map(|track|super::animation::sample(track,if track.clock.as_deref()==Some("show"){t.clock.position_ms}else{t.clock.segment_ms}))).unwrap_or(base)};
            let(x,y,w,h)=(property("x","left"),property("y","top"),property("width","width"),property("height","height"));let scale=(1280_f64/p.width as f64).min(720_f64/p.height as f64);let ox=(1280.-p.width as f64*scale)/2.;let oy=(720.-p.height as f64*scale)/2.;
            fn uses_slot(n:&super::presentation::Node,id:&str)->bool{n.slot_id.as_deref()==Some(id)||n.children.iter().any(|child|uses_slot(child,id))}
            let active_bindings=bindings.iter().filter(|(slot,_)|uses_slot(&p.root,slot)).map(|(slot,source)|(slot.clone(),source.clone())).collect();
            handle.presentation_apply(Request{asset_ids:None,preload:None,generation:status.generation,lease:lease.clone(),projection:p,bindings:active_bindings})?;
            std::thread::sleep(Duration::from_millis(400));let pixels=capture(&path,&format!("morph-{index}"))?;let cy=(oy+(y+h/2.)*scale).round()as usize;
            let green=|rgb:(u8,u8,u8)|rgb.0<60&&rgb.1>60&&rgb.1 as u16>rgb.0 as u16*2&&rgb.1 as u16*2>rgb.2 as u16*3;let row:Vec<_>=(0..1280).filter(|col|green(pixel(&pixels,*col,cy))).collect();
            let left=*row.first().ok_or("Animated camera pixels absent")?as f64;let right=*row.last().unwrap()as f64;let expected_left=ox+x*scale;let expected_right=ox+(x+w)*scale;
            if(left-expected_left).abs()>4.||(right-expected_right).abs()>4.{return Err(format!("Native morph rectangle mismatch {index}: {left}..{right}, expected {expected_left}..{expected_right}"));}
            samples.push(serde_json::json!({"x":x,"y":y,"width":w,"height":h,"left":left,"right":right}));
          }
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Morph mutated shared source state".into());}
          handle.presentation_return(Some(lease))?;return Ok(serde_json::json!({"ok":true,"nativeMorphFrames":samples,"sourcesUnchanged":true}));
        }
        if path.join("combo-check").exists(){
          use super::presentation::{Projection,Request};use base64::Engine;
          let portraits:Vec<Projection>=serde_json::from_slice(&std::fs::read(path.join("portraits.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          let bindings:std::collections::HashMap<String,String>=std::collections::HashMap::from([("host".into(),"set-probe-host".into()),("cohost".into(),"set-probe-guest".into())]);
          let portrait_lease=uuid::Uuid::new_v4().to_string();let generation=status.generation;
          let at=|mut p:Projection,revision:u64|{p.revision=revision;let c=&mut p.timeline.as_mut().unwrap().clock;c.running=false;c.position_ms=1800.;c.segment_ms=1800.;c.anchor_ms=super::animation::utc_ms();p};
          let mut samples=Vec::new();
          fn uses_slot(n:&super::presentation::Node,id:&str)->bool{n.slot_id.as_deref()==Some(id)||n.children.iter().any(|c|uses_slot(c,id))}
          for(i,(p,v))in projections.iter().zip(portraits.iter()).enumerate(){
            let revision=i as u64+1;
            let active_bindings=bindings.iter().filter(|(slot,_)|uses_slot(&p.root,slot)).map(|(k,v)|(k.clone(),v.clone())).collect::<std::collections::HashMap<_,_>>();
            handle.presentation_apply(Request{asset_ids:None,preload:None,generation,lease:lease.clone(),projection:at(p.clone(),revision),bindings:active_bindings.clone()})?;
            handle.portrait_apply(Request{asset_ids:None,preload:None,generation,lease:portrait_lease.clone(),projection:at(v.clone(),revision),bindings:active_bindings})?;
            let _=handle.portrait_frame()?;std::thread::sleep(Duration::from_millis(850));
            let image=capture(&path,&format!("combo-{i}"))?;
            let lit=(0..720).flat_map(|y|(0..1280).map(move|x|(x,y))).filter(|&(x,y)|{let(r,g,b)=pixel(&image,x,y);r>35||g>35||b>35}).count();
            if lit<10000{return Err(format!("Combo layout {i} did not render"));}
            let portrait=base64::engine::general_purpose::STANDARD.decode(handle.portrait_frame()?).map_err(|e|e.to_string())?;
            std::fs::write(path.join(format!("combo-portrait-{i}.jpg")),portrait).map_err(|e|e.to_string())?;
            samples.push(lit);
          }
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Combo modified shared host sources".into());}
          let frame_ms=unsafe{ffi::obs_get_average_frame_time_ns()as f64/1e6};let fps=unsafe{ffi::obs_get_active_fps()};
          handle.presentation_return(Some(lease))?;
          return Ok(serde_json::json!({"ok":true,"landscapeLayouts":samples.len(),"portraitLayouts":portraits.len(),"sourcesUnchanged":true,"renderMs":frame_ms,"fps":fps,"litPixels":samples}));
        }
        if path.join("shader-check").exists(){
          use super::presentation::{Projection,Request};use base64::Engine;
          let bindings=std::collections::HashMap::from([("host".into(),"set-probe-host".into())]);let generation=status.generation;
          fn at(p:&mut Projection,revision:u64,time:f64,running:bool){p.revision=revision;let c=&mut p.timeline.as_mut().unwrap().clock;c.running=running;c.position_ms=time;c.segment_ms=time;c.anchor_ms=super::animation::utc_ms();}
          fn same_area(a:&[u8],b:&[u8],rect:(usize,usize,usize,usize))->bool{let(x,y,w,h)=rect;(y..y+h).all(|row|a[(row*1280+x)*4..(row*1280+x+w)*4]==b[(row*1280+x)*4..(row*1280+x+w)*4])}
          fn delta(a:&[u8],b:&[u8],rect:(usize,usize,usize,usize))->f64{let(x,y,w,h)=rect;let mut sum=0u64;for row in y..y+h{for col in x..x+w{for ch in 0..3{let i=(row*1280+col)*4+ch;sum+=(a[i]as i32-b[i]as i32).unsigned_abs()as u64;}}}sum as f64/(w*h*3)as f64}
          std::thread::sleep(Duration::from_millis(2200));let baseline_ms=unsafe{ffi::obs_get_average_frame_time_ns()as f64/1e6};
          let make=|p:Projection|{let preload=projections.iter().position(|n|n.root.id==p.root.id).and_then(|i|projections.get(i+1)).cloned().map(|mut n|{at(&mut n,p.revision,0.,false);n});Request{asset_ids:None,preload,generation,lease:lease.clone(),projection:p,bindings:bindings.clone()}};
          let mut p=projections[0].clone();at(&mut p,1,0.,false);handle.presentation_warm(make(p.clone()))?;handle.presentation_apply(make(p.clone()))?;
          std::thread::sleep(Duration::from_millis(300));let first=capture(&path,"shader-zero")?;
          // The lower-left area contains only the native aurora, not text or camera.
          if pixel(&first,64,550)==(8,13,26){return Err("Shader backdrop was not rendered".into());}
          at(&mut p,2,4500.,false);handle.presentation_apply(make(p.clone()))?;std::thread::sleep(Duration::from_millis(200));let sought=capture(&path,"shader-seek")?;
          let movement=delta(&first,&sought,(64,510,620,90));if movement<0.5{return Err(format!("Shader clock did not affect native pixels: delta={movement}"));}
          std::thread::sleep(Duration::from_millis(250));let frozen=capture(&path,"shader-paused")?;if !same_area(&sought,&frozen,(64,510,620,90)){return Err("Native shader moved while paused".into());}
          let mut disabled=p.clone();disabled.revision=3;for n in &mut disabled.root.children{if let Some(s)=n.shader.as_mut(){s.intensity=0.;}}
          handle.presentation_apply(make(disabled))?;std::thread::sleep(Duration::from_millis(200));let dark=capture(&path,"shader-disabled")?;
          let parameter_delta=delta(&sought,&dark,(64,510,620,90));if parameter_delta<1.{return Err("Shader intensity parameter did not affect output".into());}
          at(&mut p,4,0.,false);handle.presentation_apply(make(p.clone()))?;std::thread::sleep(Duration::from_millis(200));let reset=capture(&path,"shader-reset")?;if !same_area(&first,&reset,(64,510,620,90)){return Err("Shader reset did not reproduce frame zero".into());}
          let portraits:Vec<Projection>=serde_json::from_slice(&std::fs::read(path.join("portraits.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;let portrait_lease=uuid::Uuid::new_v4().to_string();
          let portrait=|p:Projection|Request{asset_ids:None,preload:None,generation,lease:portrait_lease.clone(),projection:p,bindings:bindings.clone()};
          let mut v=portraits[0].clone();at(&mut v,1,4500.,false);handle.portrait_apply(portrait(v.clone()))?;let _=handle.portrait_frame()?;std::thread::sleep(Duration::from_millis(600));
          let jpeg=handle.portrait_frame()?;std::fs::write(path.join("shader-portrait.jpg"),base64::engine::general_purpose::STANDARD.decode(&jpeg).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          std::thread::sleep(Duration::from_millis(350));if handle.portrait_frame()?!=jpeg{return Err("Portrait shader did not remain paused".into());}
          at(&mut p,5,0.,true);at(&mut v,2,0.,true);handle.presentation_apply(make(p.clone()))?;handle.portrait_apply(portrait(v))?;
          std::thread::sleep(Duration::from_millis(3200));let animated=capture(&path,"shader-playing")?;std::thread::sleep(Duration::from_millis(250));let advanced=capture(&path,"shader-advanced")?;if same_area(&animated,&advanced,(64,510,620,90)){return Err("Shader did not advance during playback".into());}
          let dual_ms=unsafe{ffi::obs_get_average_frame_time_ns()as f64/1e6};let fps=unsafe{ffi::obs_get_active_fps()};
          let mut off=p.clone();at(&mut off,6,6000.,true);for n in &mut off.root.children{if let Some(s)=n.shader.as_mut(){s.opacity=0.;}}
          let mut voff=portraits[0].clone();at(&mut voff,3,6000.,true);for n in &mut voff.root.children{if let Some(s)=n.shader.as_mut(){s.opacity=0.;}}
          let mut off_request=make(off);off_request.preload=None;handle.presentation_apply(off_request)?;handle.portrait_apply(portrait(voff))?;std::thread::sleep(Duration::from_millis(3600));
          let off_ms=unsafe{ffi::obs_get_average_frame_time_ns()as f64/1e6};let off_fps=unsafe{ffi::obs_get_active_fps()};
          let mut cuts=Vec::new();for(i,mut n)in projections.iter().skip(1).cloned().enumerate(){at(&mut n,10+i as u64,0.,true);let start=std::time::Instant::now();handle.presentation_apply(make(n))?;cuts.push(start.elapsed().as_millis());std::thread::sleep(Duration::from_millis(1000));capture(&path,&format!("shader-segment-{}",i+2))?;}
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Shader layers modified shared sources".into());}
          handle.presentation_return(Some(lease))?;return Ok(serde_json::json!({"ok":true,"nativeShaderPixels":true,"pauseSeekReset":true,"parameterUpdates":true,"portraitShaders":true,"sourcesUnchanged":true,"shaderPixelDelta":movement,"intensityPixelDelta":parameter_delta,"baselineRenderMs":baseline_ms,"dualCanvasRenderMs":dual_ms,"activeFps":fps,"dualCanvasShadersOffMs":off_ms,"shadersOffFps":off_fps,"segmentApplyMs":cuts}));
        }
        if path.join("animation-check").exists(){
          use super::presentation::{Projection,Request};
          let bindings=std::collections::HashMap::from([("host".into(),"set-probe-host".into())]);
          let generation=status.generation;
          fn at(p:&mut Projection,revision:u64,show:f64,segment:f64,running:bool){p.revision=revision;let c=&mut p.timeline.as_mut().unwrap().clock;c.running=running;c.position_ms=show;c.segment_ms=segment;c.anchor_ms=super::animation::utc_ms();}
          fn green_bounds(pixels:&[u8])->Result<(usize,usize,usize,usize),String>{let(mut x0,mut y0,mut x1,mut y1)=(1280,720,0,0);for y in 160..680{for x in 0..1280{let c=pixel(pixels,x,y);if c.1>145&&c.0<75&&c.2<135{x0=x0.min(x);x1=x1.max(x);y0=y0.min(y);y1=y1.max(y);}}}if x0>x1{Err("Animated native camera did not render".into())}else{Ok((x0,y0,x1,y1))}}
          let make=|p:Projection|Request{asset_ids:None,preload:None,generation,lease:lease.clone(),projection:p,bindings:bindings.clone()};
          let mut first=projections[0].clone();at(&mut first,1,0.,0.,false);handle.presentation_warm(make(first.clone()))?;
          at(&mut first,2,0.,0.,true);handle.presentation_apply(make(first.clone()))?;std::thread::sleep(Duration::from_millis(250));
          at(&mut first,3,500.,500.,false);handle.presentation_apply(make(first.clone()))?;std::thread::sleep(Duration::from_millis(180));
          let paused=capture(&path,"animation-paused")?;let paused_bounds=green_bounds(&paused)?;
          std::thread::sleep(Duration::from_millis(300));let still=capture(&path,"animation-still")?;if green_bounds(&still)?!=paused_bounds{return Err("Native animation moved while paused".into());}
          let tracks=&first.timeline.as_ref().unwrap().tracks;let x=super::animation::sample(tracks.iter().find(|t|t.property=="x"&&t.target.ends_with("/camera")).unwrap(),500.);
          if (paused_bounds.0 as f64-x).abs()>8.{return Err(format!("Native camera timing diverged: {:?}, expected x={x}",paused_bounds));}
          at(&mut first,4,1000.,1000.,false);handle.presentation_apply(make(first.clone()))?;std::thread::sleep(Duration::from_millis(180));let sought=green_bounds(&capture(&path,"animation-seek")?)?;
          if sought.0>=paused_bounds.0||sought.2-sought.0<=paused_bounds.2-paused_bounds.0{return Err("Native seek did not move and resize the camera".into());}
          at(&mut first,5,0.,0.,false);handle.presentation_apply(make(first.clone()))?;std::thread::sleep(Duration::from_millis(180));let reset=green_bounds(&capture(&path,"animation-reset")?)?;
          if reset.0<=paused_bounds.0{return Err("Reset did not restore the first camera frame".into());}
          let mut second=projections[1].clone();at(&mut second,6,1000.,0.,true);handle.presentation_apply(make(second.clone()))?;
          at(&mut second,7,1500.,500.,false);handle.presentation_apply(make(second.clone()))?;std::thread::sleep(Duration::from_millis(180));let half=capture(&path,"crossfade-half")?;let color=pixel(&half,8,8);
          if color.1<25||color.1>47{return Err(format!("Native crossfade did not blend backdrops at half time: {color:?}"));}
          std::thread::sleep(Duration::from_millis(300));let frozen=capture(&path,"crossfade-paused")?;if pixel(&frozen,8,8)!=color{return Err("Crossfade advanced while paused".into());}
          at(&mut second,8,1500.,500.,true);handle.presentation_apply(make(second.clone()))?;std::thread::sleep(Duration::from_millis(700));let end=capture(&path,"crossfade-end")?;
          if pixel(&end,8,8).1<50{return Err("Crossfade did not finish after resume".into());}
          let portraits:Vec<Projection>=serde_json::from_slice(&std::fs::read(path.join("portraits.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;let portrait_lease=uuid::Uuid::new_v4().to_string();
          let portrait=|p:Projection|Request{asset_ids:None,preload:None,generation,lease:portrait_lease.clone(),projection:p,bindings:bindings.clone()};
          let mut p=portraits[0].clone();at(&mut p,1,500.,500.,false);handle.portrait_apply(portrait(p.clone()))?;let _=handle.portrait_frame()?;std::thread::sleep(Duration::from_millis(550));
          use base64::Engine;let a=handle.portrait_frame()?;std::fs::write(path.join("portrait-paused.jpg"),base64::engine::general_purpose::STANDARD.decode(&a).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          std::thread::sleep(Duration::from_millis(350));let b=handle.portrait_frame()?;if a!=b{return Err("Portrait animation did not remain paused".into());}
          let mut p=portraits[1].clone();at(&mut p,2,1000.,0.,true);handle.portrait_apply(portrait(p.clone()))?;at(&mut p,3,1500.,500.,false);handle.portrait_apply(portrait(p.clone()))?;std::thread::sleep(Duration::from_millis(550));
          let half=handle.portrait_frame()?;std::fs::write(path.join("portrait-crossfade.jpg"),base64::engine::general_purpose::STANDARD.decode(&half).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          std::thread::sleep(Duration::from_millis(350));if handle.portrait_frame()?!=half{return Err("Portrait crossfade advanced while paused".into());}
          at(&mut p,4,2000.,1000.,false);handle.portrait_apply(portrait(p))?;std::thread::sleep(Duration::from_millis(550));std::fs::write(path.join("portrait-end.jpg"),base64::engine::general_purpose::STANDARD.decode(handle.portrait_frame()?).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Animation modified original room sources".into());}
          handle.presentation_return(Some(lease))?;return Ok(serde_json::json!({"ok":true,"nativeCameraMovement":true,"nativeCameraResize":true,"pauseAndSeek":true,"reset":true,"crossfadePauseResume":true,"portraitPauseAndCrossfade":true,"sourcesUnchanged":true,"pausedCameraBounds":paused_bounds,"seekCameraBounds":sought,"crossfadeHalfPixel":color}));
        }
        if path.join("speed-check").exists(){
          use std::time::Instant;
          use super::presentation::{Request,Projection};
          let mut timings=Vec::new();
          let mut initial=projections[0].clone();
          let bindings=std::collections::HashMap::from([("host".into(),"set-probe-host".into())]);
          let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64;
          fn anchor(n:&mut super::presentation::Node,now:f64){if let Some(t)=n.playback.as_mut(){t.anchor_ms=now;}for c in &mut n.children{anchor(c,now);}}
          anchor(&mut initial.root,now);
          let start=Instant::now();handle.presentation_warm(Request{asset_ids:None,preload:Some(projections[1].clone()),generation:status.generation,lease:lease.clone(),projection:initial.clone(),bindings:bindings.clone()})?;
          timings.push(serde_json::json!({"kind":"background-warm","ms":start.elapsed().as_millis()}));
          let warmed_room=capture(&path,"room-after-warm")?;if pixel(&warmed_room,8,8)!=pixel(&before,8,8){return Err("Background warmup changed room output".into());}
          std::thread::sleep(Duration::from_millis(600));initial.revision=2;
          let mut prepared=initial.clone();prepared.assets.clear();let start=Instant::now();handle.presentation_apply(Request{asset_ids:None,preload:Some(projections[1].clone()),generation:status.generation,lease:lease.clone(),projection:prepared,bindings:bindings.clone()})?;
          timings.push(serde_json::json!({"kind":"prepared-send","ms":start.elapsed().as_millis()}));
          for revision in 3..=6{
            let mut p=initial.clone();p.revision=revision;p.assets.clear();
            let color=if revision%2==0{"#112233"}else{"#445566"};p.root.styles.insert("background".into(),serde_json::json!(color));
            let start=Instant::now();handle.presentation_apply(Request{asset_ids:None,preload:None,generation:status.generation,lease:lease.clone(),projection:p,bindings:bindings.clone()})?;
            let ack_ms=start.elapsed().as_millis();let expected=if revision%2==0{(17,34,51)}else{(68,85,102)};
            let mut actual=(0,0,0);let mut matched=false;
            // Raw output callbacks can carry the preceding encoder frame after
            // the source texture has updated. Measure the first matching frame.
            for sample in 0..4{let pixels=capture(&path,&format!("patch-{revision}-{sample}"))?;actual=pixel(&pixels,8,8);if (actual.0 as i16-expected.0).abs()<=4&&(actual.1 as i16-expected.1).abs()<=4&&(actual.2 as i16-expected.2).abs()<=4{matched=true;break;}}
            if !matched{return Err(format!("Patch did not reach GPU pixels: {actual:?}, expected {expected:?}"));}
            timings.push(serde_json::json!({"kind":"patch","ms":start.elapsed().as_millis(),"ackMs":ack_ms,"pixel":actual}));
          }
          for(index,p)in projections.iter().enumerate().skip(1){
            // Model a host presenting the current segment while the next
            // segment's decode and camera filters finish off air.
            std::thread::sleep(Duration::from_millis(1800));
            let mut p=p.clone();p.revision+=1;anchor(&mut p.root,now);p.assets.clear();
            let preload=projections.get(index+1).cloned();let start=Instant::now();handle.presentation_apply(Request{asset_ids:None,preload,generation:status.generation,lease:lease.clone(),projection:p,bindings:bindings.clone()})?;
            let ack_ms=start.elapsed().as_millis();let mut matched=false;
            let x=if index==1{174}else{1104};
            for sample in 0..5{let pixels=capture(&path,&format!("warm-{index}-{sample}"))?;let actual=pixel(&pixels,x,621);if actual.1>140&&actual.0<80&&actual.2<140{matched=true;break;}}
            if !matched{return Err(format!("Prepared cut {index} did not place the host in its assigned camera box"));}
            timings.push(serde_json::json!({"kind":"warm-cut","ms":start.elapsed().as_millis(),"ackMs":ack_ms}));
          }
          let mut portrait_projections:Vec<Projection>=serde_json::from_slice(&std::fs::read(path.join("portraits.json")).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          let portrait_now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()as f64;for p in &mut portrait_projections{anchor(&mut p.root,portrait_now);}
          let portrait_lease=uuid::Uuid::new_v4().to_string();
          let start=Instant::now();handle.portrait_warm(Request{asset_ids:None,preload:Some(portrait_projections[1].clone()),generation:status.generation,lease:portrait_lease.clone(),projection:portrait_projections[0].clone(),bindings:bindings.clone()})?;
          timings.push(serde_json::json!({"kind":"portrait-background-warm","ms":start.elapsed().as_millis()}));
          std::thread::sleep(Duration::from_millis(600));let mut first=portrait_projections[0].clone();first.revision=2;first.assets.clear();
          let start=Instant::now();handle.portrait_apply(Request{asset_ids:None,preload:Some(portrait_projections[1].clone()),generation:status.generation,lease:portrait_lease.clone(),projection:first,bindings:bindings.clone()})?;
          timings.push(serde_json::json!({"kind":"portrait-prepared-send","ms":start.elapsed().as_millis()}));
          let mut p=portrait_projections[0].clone();p.revision=3;p.assets.clear();p.root.styles.insert("background".into(),serde_json::json!("#123456"));
          let start=Instant::now();handle.portrait_apply(Request{asset_ids:None,preload:None,generation:status.generation,lease:portrait_lease.clone(),projection:p,bindings:bindings.clone()})?;
          timings.push(serde_json::json!({"kind":"portrait-patch","ms":start.elapsed().as_millis()}));
          std::thread::sleep(Duration::from_millis(1800));let mut p=portrait_projections[1].clone();p.revision=4;p.assets.clear();let start=Instant::now();handle.portrait_apply(Request{asset_ids:None,preload:None,generation:status.generation,lease:portrait_lease,projection:p,bindings:bindings.clone()})?;
          timings.push(serde_json::json!({"kind":"portrait-warm-cut","ms":start.elapsed().as_millis()}));
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Warm updates mutated the room sources".into());}
          let mut pending=initial;pending.revision=9;
          let(tx,rx)=mpsc::channel();handle.probe_sender().send(Command::PresentationPrepare{request:Request{asset_ids:None,preload:None,generation:status.generation,lease:lease.clone(),projection:pending,bindings},reply:tx}).map_err(|e|e.to_string())?;
          let bridge=rx.recv_timeout(Duration::from_secs(10)).map_err(|e|e.to_string())??;
          handle.presentation_return(Some(lease))?;if bridge.wait_revision(9).is_ok(){return Err("Returned room accepted a queued warm update".into());}
          return Ok(serde_json::json!({"ok":true,"timings":timings,"gpuPatchVerified":true,"sourcesUnchanged":true,"cancelledWarmUpdate":true}));
        }
        if path.join("media-check").exists(){
          handle.presentation_apply(super::presentation::Request{asset_ids:None,preload:None,generation:status.generation,lease:lease.clone(),projection:projections[0].clone(),bindings:Default::default()})?;
          std::thread::sleep(Duration::from_millis(2000));let pixels=capture(&path,"media-output")?;
          let picture=pixel(&pixels,175,330);if picture.0<200||picture.1>80||picture.2<200{return Err(format!("Embedded PNG did not render: {picture:?}"));}
          let video=pixel(&pixels,1075,330);if video==pixel(&pixels,8,8){return Err("Embedded video did not render".into());}
          let color=pixel(&pixels,775,330);
          if color.1<150||color.0>100{return Err(format!("Native Lottie did not render expected green: {color:?}"));}
          handle.presentation_return(Some(lease))?;
          return Ok(serde_json::json!({"ok":true,"embeddedMediaNative":true,"lottiePixel":color,"imagePixel":picture,"videoPixel":video}));
        }
        #[cfg(target_os="macos")]
        if path.join("portrait-check").exists(){
          use base64::Engine;
          let room=handle.portrait_room()?;
          if room.items.len()!=2{return Err(format!("Portrait room omitted sources without a set: {}",serde_json::to_string(&room).unwrap()));}
          let portrait_before=serde_json::to_value(&handle.portrait_state()?.items).map_err(|e|e.to_string())?;
          let original=handle.snapshot.lock().unwrap().sources.items.iter().find(|s|s.id=="set-probe-host").map(|s|(s.x,s.y,s.w,s.h,s.rot,s.z,s.visible,s.crop_left,s.crop_top,s.crop_right,s.crop_bottom)).unwrap();
          handle.set_transform("set-probe-host".into(),super::graph::TransformPatch{x:Some(321.0),y:Some(123.0),w:Some(500.0),h:Some(400.0),rot:Some(15.0),z:Some(4),visible:Some(false),crop_left:Some(12),..Default::default()},true)?;
          let portrait_after=serde_json::to_value(&handle.portrait_state()?.items).map_err(|e|e.to_string())?;
          if portrait_before!=portrait_after{return Err("Landscape transform leaked into portrait before its first edit".into());}
          handle.set_transform("set-probe-host".into(),super::graph::TransformPatch{x:Some(original.0),y:Some(original.1),w:Some(original.2),h:Some(original.3),rot:Some(original.4),z:Some(original.5),visible:Some(original.6),crop_left:Some(original.7),crop_top:Some(original.8),crop_right:Some(original.9),crop_bottom:Some(original.10)},true)?;
          let edited=handle.portrait_transform("set-probe-host".into(),super::graph::TransformPatch{x:Some(40.0),y:Some(80.0),w:Some(640.0),h:Some(960.0),crop_left:Some(10),..Default::default()})?;
          let host=edited.items.iter().find(|s|s.id=="set-probe-host").ok_or("Portrait host absent")?;
          if host.x!=40.0||host.y!=80.0||host.w!=640.0||host.h!=960.0||host.crop_left!=10{return Err("Portrait room transforms were not applied".into());}
          handle.portrait_transform("set-probe-guest".into(),super::graph::TransformPatch{visible:Some(false),..Default::default()})?;
          extern "C" {fn producer_preview_probe_window()->*mut std::ffi::c_void;}
          let window=unsafe{producer_preview_probe_window()} as usize;if window==0{return Err("Native display probe has no app window".into());}
          crate::live::prepare_stage(window);
          let start=super::engine::PORTRAIT_DRAWS.load(Ordering::Relaxed);
          handle.portrait_preview(window,Some(super::engine::PreviewRect{x:40.0,y:150.0,w:180.0,h:320.0}))?;
          std::thread::sleep(Duration::from_millis(2000));
          let native_draws=super::engine::PORTRAIT_DRAWS.load(Ordering::Relaxed)-start;
          if native_draws<15{return Err(format!("Native portrait display stalled: {native_draws} draws"));}
          handle.portrait_preview(window,None)?;
          handle.add_extra("portrait-late-source".into(),"Late source".into(),ExtraSpec::Color{color:"#4080ff".into()})?;
          if !handle.portrait_state()?.items.iter().any(|s|s.id=="portrait-late-source"){return Err("New room source did not reach portrait".into());}
          handle.remove_extra("portrait-late-source".into())?;
          if handle.portrait_state()?.items.iter().any(|s|s.id=="portrait-late-source"){return Err("Removed room source survived portrait".into());}
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Portrait room edits changed landscape source state".into());}
          handle.portrait_room()?;let saved=handle.portrait_state()?;
          if saved.items.iter().find(|s|s.id=="set-probe-host").map(|s|s.x)!=Some(40.0){return Err("Switching views lost portrait framing".into());}
          if path.join("tone.wav").exists(){handle.add_extra("dual-audio".into(),"Test tone".into(),ExtraSpec::Media{path:path.join("tone.wav").to_string_lossy().into_owned(),looping:true})?;std::thread::sleep(Duration::from_millis(500));}
          let recorded=handle.start_recording_mode("Portrait dual acceptance".into(),true)?;
          std::thread::sleep(Duration::from_secs(3));
          handle.stop_recording()?;
          if path.join("tone.wav").exists(){handle.remove_extra("dual-audio".into())?;}
          let portrait_recorded=recorded.strip_suffix(".mp4").unwrap().to_owned()+" Portrait.mp4";
          for file in [&recorded,&portrait_recorded]{if std::fs::metadata(file).map_err(|e|e.to_string())?.len()<1000{return Err("Dual recording produced an empty file".into());}}
          std::fs::write(path.join("recording-paths.json"),serde_json::to_vec(&[recorded,portrait_recorded]).unwrap()).map_err(|e|e.to_string())?;
          let projection=projections[0].clone();let request=super::presentation::Request{asset_ids:None,preload:None,generation:status.generation,lease:lease.clone(),projection,bindings:std::collections::HashMap::from([("host".into(),"set-probe-host".into())])};
          handle.portrait_apply(request.clone())?;
          if handle.portrait_apply(request).is_ok(){return Err("Duplicate portrait revision accepted".into());}
          std::thread::sleep(Duration::from_millis(1200));
          let mut jpeg=String::new();for _ in 0..50{jpeg=handle.portrait_frame()?;if !jpeg.is_empty(){break;}std::thread::sleep(Duration::from_millis(100));}
          if jpeg.is_empty(){return Err("Portrait native preview never produced a frame".into());}
          std::fs::write(path.join("portrait.jpg"),base64::engine::general_purpose::STANDARD.decode(jpeg).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
          let during=capture(&path,"landscape-during-portrait")?;
          if pixel(&before,8,8)!=pixel(&during,8,8){return Err("Portrait changed the landscape composition".into());}
          if serde_json::to_value(&handle.snapshot.lock().unwrap().sources).map_err(|e|e.to_string())?!=baseline{return Err("Portrait mutated source assignments or framing".into());}
          handle.portrait_stop()?;
          if !handle.portrait_frame()?.is_empty(){return Err("Portrait frame survived output teardown".into());}
          let after=capture(&path,"landscape-after-portrait")?;
          if pixel(&before,8,8)!=pixel(&after,8,8){return Err("Landscape did not survive portrait teardown".into());}
          return Ok(serde_json::json!({"ok":true,"portraitNativeFrame":true,"nativeDisplayDraws":native_draws,"roomWithoutSet":true,"dualRecording":true,"independentRoomTransforms":true,"landscapeEditsDoNotMovePortrait":true,"roomSourceLifecycle":true,"duplicateRevisionRejected":true,"landscapeUnchanged":true,"sourcesUnchanged":true,"portraitStopped":true}));
        }
        let mut results=Vec::new();
        for (index,projection) in projections.into_iter().enumerate() {
          let mut bindings=std::collections::HashMap::from([("host".into(),"set-probe-host".into())]);
          if index!=1{bindings.insert("guest".into(),"set-probe-guest".into());}
          let request=super::presentation::Request{asset_ids:None,preload:None,generation:status.generation,lease:lease.clone(),projection,bindings};
          let applied=handle.presentation_apply(request.clone())?;
          std::thread::sleep(Duration::from_millis(1500));
          let pixels=capture(&path,&format!("set-{index}"))?;
          let corner=pixel(&pixels,8,8);
          if corner==pixel(&before,8,8){return Err("Set backdrop did not replace the room pixels".into());}
          results.push(serde_json::json!({"revision":applied.revision,"corner":corner}));
          // The capture graph remains the original graph, including its transforms,
          // visibility, muted state, sync offsets and source identities.
          let sources=handle.snapshot.lock().unwrap().sources.clone();
          if serde_json::to_value(&sources).map_err(|e|e.to_string())?!=baseline {return Err(format!("Set changed the original room source state: baseline={}, current={}",baseline,serde_json::to_value(sources).unwrap()));}
          if handle.presentation_apply(request).is_ok(){return Err("A duplicate revision was accepted".into());}
        }
        let returned=handle.presentation_return(Some(lease.clone()))?;
        if returned.lease.is_some() || returned.generation==status.generation {return Err("Return did not fence the old composition".into());}
        std::thread::sleep(Duration::from_millis(200));let after=capture(&path,"room-after")?;
        if pixel(&before,8,8)!=pixel(&after,8,8){return Err("Return did not restore the room pixels".into());}
        // A cancelled off-air preparation must not reactivate after Return.
        let projection:super::presentation::Projection=serde_json::from_slice::<Vec<super::presentation::Projection>>(&std::fs::read(path.join("projections.json")).unwrap()).unwrap()[0].clone();
        let (tx,rx)=mpsc::channel();handle.probe_sender().send(Command::PresentationPrepare{request:super::presentation::Request{asset_ids:None,preload:None,generation:returned.generation,lease:lease.clone(),projection,bindings:Default::default()},reply:tx}).map_err(|e|e.to_string())?;
        let bridge=rx.recv_timeout(Duration::from_secs(10)).map_err(|e|e.to_string())??;
        handle.presentation_return(Some(lease))?;
        if bridge.wait().is_ok(){return Err("Cancelled preparation remained active".into());}
        Ok(serde_json::json!({"ok":true,"frames":results,"baseline":baseline,"cancelledPreparation":true,"roomRestored":true}))
      })();
      let result=match test{Ok(v)=>v,Err(e)=>serde_json::json!({"ok":false,"error":e})};
      let _=std::fs::write(path.join("result.json"),serde_json::to_vec_pretty(&result).unwrap());
    });
    Ok(())
}
