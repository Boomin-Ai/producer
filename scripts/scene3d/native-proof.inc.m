/* Included by the isolated native probe. Never linked into the application. */
#import <AVFoundation/AVFoundation.h>
static obs_source_t *scene3d_browser(NSString *url, NSString *name, int w, int h) {
 NSDictionary *settings=@{@"url":url,@"width":@(w),@"height":@(h),@"fps":@(getenv("PRODUCER_PROBE_SCENE3D_CEF_FPS")?atoi(getenv("PRODUCER_PROBE_SCENE3D_CEF_FPS")):30),@"fps_custom":@YES,@"shutdown":@NO,@"restart_when_active":@NO,@"reroute_audio":@YES,@"webpage_control_level":@0,@"css":@""};
 NSData *json=[NSJSONSerialization dataWithJSONObject:settings options:0 error:nil];
 obs_data_t *data=obs_data_create_from_json([[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
 obs_source_t *source=obs_source_create_private("browser_source",name.UTF8String,data);obs_data_release(data);require(source!=NULL,"create native Three.js browser source");obs_source_set_audio_mixers(source,0);return source;
}
static NSDictionary *scene3d_report(NSDictionary *manifest) {
 NSData *data=[NSData dataWithContentsOfURL:[NSURL URLWithString:manifest[@"report"]]];
 return data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
}
static NSString *scene3dRun;
static bool scene3d_ready(NSDictionary *report, NSString *orientation) {
 for(NSString *pass in @[@"background",@"foreground"]){NSDictionary *r=report[@"telemetry"][[NSString stringWithFormat:@"%@/%@",orientation,pass]];if(![r[@"run"] isEqualToString:scene3dRun]||![r[@"ready"]boolValue]||![r[@"webgl2"]boolValue]||[r[@"lost"]boolValue]||r[@"error"])return false;}return true;
}
static NSDictionary *scene3d_proof(NSString *app, NSString *out) {
 NSDictionary *manifest=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(getenv("PRODUCER_PROBE_SCENE3D_MANIFEST"))] options:0 error:nil];require(manifest!=nil,"read Three renderer manifest");
 load_plugin(app,@"obs-browser");obs_post_load_modules();
 scene3dRun=[NSUUID UUID].UUIDString;
 bool portrait=getenv("PRODUCER_PROBE_SCENE3D_PORTRAIT")!=NULL;int w=portrait?1080:1920,h=portrait?1920:1080;
 NSString *orientation=portrait?@"portrait":@"landscape";
 obs_source_t *back=scene3d_browser([manifest[portrait?@"portraitBackground":@"background"] stringByAppendingFormat:@"&run=%@",scene3dRun],@"Three stage",w,h),*front=scene3d_browser([manifest[portrait?@"portraitForeground":@"foreground"] stringByAppendingFormat:@"&run=%@",scene3dRun],@"Three transparent trim",w,h);
 obs_source_t *root=producer_set_v2_group_create(w,h,0,1),*live=NULL;
 bool physical=getenv("PRODUCER_PROBE_SCENE3D_CAMERA")!=NULL;
 if(physical){
  load_plugin(app,@"mac-avcapture");obs_post_load_modules();
  AVAuthorizationStatus auth=[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo];
  if(auth==AVAuthorizationStatusNotDetermined){dispatch_semaphore_t granted=dispatch_semaphore_create(0);[AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo completionHandler:^(BOOL ok){dispatch_semaphore_signal(granted);}];dispatch_semaphore_wait(granted,dispatch_time(DISPATCH_TIME_NOW,60*NSEC_PER_SEC));}
  require([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]==AVAuthorizationStatusAuthorized,"local camera permission granted");
  AVCaptureDevice *device=[AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];require(device!=nil,"physical camera available");
  NSDictionary *settings=@{@"device":device.uniqueID,@"use_preset":@YES,@"preset":@"AVCaptureSessionPreset1280x720",@"buffering":@NO};
  NSData *json=[NSJSONSerialization dataWithJSONObject:settings options:0 error:nil];obs_data_t *d=obs_data_create_from_json([[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
  live=obs_source_create_private("macos-avcapture","Physical camera — local proof only",d);obs_data_release(d);require(live!=NULL,"create physical native camera");obs_source_set_audio_mixers(live,0);
 }else live=solid(640,360,0.08,0.4,0.16,true);
 obs_source_t *other=solid(640,360,0.12,0.07,0.02,false);
 add(root,back,0,0,w,h);
 float x=portrait?.08:.055,y=portrait?.19:.3,cw=portrait?.84:.4,ch=portrait?.27:.4;
 add(root,live,x*w,y*h,cw*w,ch*h);add(root,other,(portrait?.08:.545)*w,(portrait?.55:.3)*h,cw*w,ch*h);add(root,front,0,0,w,h);producer_set_v2_group_seal(root);
 obs_source_inc_active(root);obs_source_inc_showing(root);obs_set_output_source(0,root);
 bool ready=false;for(int i=0;i<300;i++){usleep(100000);if(scene3d_ready(scene3d_report(manifest),orientation)){ready=true;break;}}
 require(ready,"both CEF WebGL2 passes compiled and rendered");usleep(2000000);
 if(physical)require(obs_source_get_width(live)>0&&obs_source_get_height(live)>0,"physical camera delivered a native video frame");
 NSData *stageFrame=capture(back,w,h,w,h);NSData *frame=capture(root,w,h,w,h);png(frame,w,h,[out stringByAppendingPathComponent:@"scene3d-native.png"]);
 NSData *alpha=capture(front,w,h,w,h);const uint8_t *corner=pixel(alpha,w,8,8);require(corner[3]==0,"foreground transparent outside authored trim");
 const uint8_t *center=pixel(alpha,w,(x+cw/2)*w,(y+ch/2)*h);require(center[3]==0,"foreground transparent inside native camera");
 if(!physical){const uint8_t *camera=pixel(frame,w,(x+cw/2)*w,(y+ch/2)*h);require(camera[1]>camera[0]*2,"native capture survives layered composition");}
 // Let native video run without pixel readback; snapshots only bracket this interval.
 usleep(6500000);NSData *next=capture(root,w,h,w,h);require(![frame isEqualToData:next],"native composite contains changing animation");NSData *nextStage=capture(back,w,h,w,h);require(![stageFrame isEqualToData:nextStage],"Three stage itself changes independently of camera motion");
 NSDictionary *telemetry=scene3d_report(manifest);require(scene3d_ready(telemetry,orientation),"3D renderers remained healthy during native output");
 NSDictionary *result=@{@"orientation":orientation,@"width":@(w),@"height":@(h),@"physicalCamera":@(physical),@"transparentCameraInterior":@YES,@"transparentOuterCorner":@YES,@"animationChangedPixels":@YES,@"telemetry":telemetry,@"scope":@"Actual libobs Metal + CEF browser sources. Snapshot readback is diagnostic only; not the frame transport. Hardware import, recording and normal room integration not yet proven."};
 obs_set_output_source(0,NULL);obs_source_dec_showing(root);obs_source_dec_active(root);obs_source_release(root);obs_source_release(back);obs_source_release(front);obs_source_release(live);obs_source_release(other);obs_wait_for_destroy_queue();return result;
}
