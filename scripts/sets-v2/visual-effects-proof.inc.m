/* Exact native compositor pixels, independent of HTML or synthetic CSS. */
static NSDictionary *visual_effects_proof(NSString *out){
 obs_source_t *red=solid(320,240,1,0,0,false),*blue=solid(160,240,0,0,1,false),*green=solid(24,24,0,1,0,false);
 obs_source_t *camera=producer_set_v2_group_create(320,240,0,1);
 require(camera&&producer_set_v2_group_effects(camera,1,0,.5,.5,0,false,0,0)&&add(camera,red,0,0,320,240)&&producer_set_v2_group_seal(camera),"create circle reveal");
 for(int step=0;step<3;step++){
  float progress=step*.5f;obs_enter_graphics();require(producer_set_v2_group_mask_progress(camera,progress),"animate circle mask");obs_leave_graphics();usleep(50000);
  NSData *frame=capture(camera,320,240,320,240);const uint8_t *center=pixel(frame,320,160,120),*corner=pixel(frame,320,0,0);
  require(step==0?center[3]==0:center[0]>245&&center[3]==255,"circle progress center alpha");require(step<2?corner[3]==0:corner[3]>245,"circle progress reveals corners only at end");
  png(frame,320,240,[out stringByAppendingPathComponent:[NSString stringWithFormat:@"circle-%d.png",step]]);
 }
 obs_source_t *wipe=producer_set_v2_group_create(320,240,0,1);require(producer_set_v2_group_effects(wipe,2,.5,.5,.5,0,false,0,0)&&add(wipe,red,0,0,320,240)&&producer_set_v2_group_seal(wipe),"create wipe reveal");
 NSData *half=capture(wipe,320,240,320,240);require(pixel(half,320,40,120)[3]==255&&pixel(half,320,280,120)[3]==0,"wipe only reveals left half");
 obs_source_t *inverse=producer_set_v2_group_create(320,240,0,1);require(producer_set_v2_group_effects(inverse,2,.5,.5,.5,0,true,0,0)&&add(inverse,red,0,0,320,240)&&producer_set_v2_group_seal(inverse),"create inverted wipe");
 half=capture(inverse,320,240,320,240);require(pixel(half,320,40,120)[3]==0&&pixel(half,320,280,120)[3]==255,"inverted wipe reverses alpha");
 // The panel has a sharp foreground tile. Blur must blend the red/blue
 // boundary under it while pixels outside the region remain untouched.
 obs_source_t *panel=producer_set_v2_group_create(200,160,12,1);require(producer_set_v2_group_effects(panel,0,1,.5,.5,0,false,0,20)&&add(panel,green,88,68,24,24)&&producer_set_v2_group_seal(panel),"create backdrop panel");
 obs_source_t *root=producer_set_v2_group_create(320,240,0,1);require(add(root,red,0,0,320,240)&&add(root,blue,160,0,160,240)&&add(root,panel,60,40,200,160)&&producer_set_v2_group_seal(root),"ordered backdrop scene");
 for(int linear=0;linear<2;linear++){
  capture_linear=linear;NSData *frame=capture(root,320,240,320,240);const uint8_t *blend=pixel(frame,320,159,70),*outside=pixel(frame,320,159,15),*front=pixel(frame,320,160,120);
  fprintf(stderr,"BACKDROP %d mixed=%u,%u,%u outside=%u,%u,%u sharp=%u,%u,%u\n",linear,blend[0],blend[1],blend[2],outside[0],outside[1],outside[2],front[0],front[1],front[2]);
  require(blend[0]>30&&blend[2]>30,"backdrop samples earlier red and blue siblings");require(outside[0]>245&&outside[2]<10,"outside backdrop remains sharp");require(front[1]>245&&front[0]<10&&front[2]<10,"foreground remains sharp above blur");
  png(frame,320,240,[out stringByAppendingPathComponent:[NSString stringWithFormat:@"backdrop-%d.png",linear]]);
 }
 capture_linear=false;
 // A translucent backdrop must replace its original samples, not compound
 // their alpha by drawing the blurred copy over the same pixels.
 obs_source_t *translucent=producer_set_v2_group_create(320,240,0,.5);
 require(add(translucent,red,0,0,320,240)&&producer_set_v2_group_seal(translucent),"translucent background");
 obs_source_t *alphaRoot=producer_set_v2_group_create(320,240,0,1);
 require(add(alphaRoot,translucent,0,0,320,240)&&add(alphaRoot,panel,60,40,200,160)&&producer_set_v2_group_seal(alphaRoot),"translucent backdrop scene");
 NSData *alphaFrame=capture(alphaRoot,320,240,320,240);
 require(abs((int)pixel(alphaFrame,320,100,70)[3]-128)<=2,"backdrop preserves translucent alpha");
 obs_source_release(alphaRoot);obs_source_release(translucent);
 // Exercise actual graphics-thread frame turnover while the owner replaces
 // and disposes scenes, including changing backdrop dimensions.
 obs_source_t *previous=NULL;
 for (int turn=0;turn<240;turn++) {
  @autoreleasepool {
   obs_source_t *glass=producer_set_v2_group_create(200+(turn%2)*20,160,12,1);
   require(glass&&producer_set_v2_group_effects(glass,0,1,.5,.5,0,false,0,12)&&producer_set_v2_group_seal(glass),"stress glass");
   obs_source_t *next=producer_set_v2_group_create(320,240,0,1);
   require(next&&add(next,red,0,0,320,240)&&add(next,blue,160,0,160,240)&&add(next,glass,40,40,200+(turn%2)*20,160)&&producer_set_v2_group_seal(next),"stress scene");
   obs_source_release(glass);
   obs_set_output_source(0,next);
   require(producer_set_v2_surface_warm(next),"graphics-thread stress warm");
   if(previous)obs_source_release(previous);
   previous=next;
  }
 }
 obs_set_output_source(0,NULL);obs_source_release(previous);
 fprintf(stderr,"STRESS: 240 live backdrop scene replacements completed\n");
 // Exercise the actual native animation track sampler at a paused midpoint,
 // then reset the cached scene before reentry.
 struct producer_set_v2_node leaf={.id="video",.kind=SET_V2_SURFACE,.width=320,.height=240,.opacity=1,.visible=true,.surface=red,.mask_progress=1};
 struct producer_set_v2_node masked={.id="reveal",.kind=SET_V2_GROUP,.width=320,.height=240,.opacity=1,.visible=true,.children=&leaf,.child_count=1,.mask_kind=2,.mask_progress=1,.mask_x=.5,.mask_y=.5};
 char error[256]={0};struct producer_set_v2_scene *scene=producer_set_v2_scene_prepare(&masked,320,240,SET_V2_STRETCH,32*1024*1024,error,sizeof(error));require(scene!=NULL,"native masked scene assembly");
 obs_source_t *program=producer_set_v2_program_create(320,240);require(program&&producer_set_v2_program_prepare(program,producer_set_v2_scene_source(scene),1),"prepare masked program");
 struct producer_set_v2_keyframe frames[]={{0,0},{1200,1}};
 require(producer_set_v2_program_track(program,1,scene,"reveal",NULL,9,frames,2,3,0,600,0,false),"native mask.progress animation track");
 require(producer_set_v2_program_cached_ready(program,1)&&producer_set_v2_program_take(program,1,0,PRODUCER_SET_V2_DISSOLVE),"take masked program");
 NSData *sample=capture(program,320,240,320,240);require(pixel(sample,320,40,120)[3]==255&&pixel(sample,320,280,120)[3]==0,"native animation midpoint is paused and exact");
 producer_set_v2_program_stop_motion(program);obs_source_release(program);producer_set_v2_scene_reset(scene);usleep(50000);
 sample=capture(producer_set_v2_scene_source(scene),320,240,320,240);require(pixel(sample,320,280,120)[3]==255,"cached mask resets to authored progress on reentry");producer_set_v2_scene_release(scene);
 obs_source_release(root);obs_source_release(panel);obs_source_release(inverse);obs_source_release(wipe);obs_source_release(camera);obs_source_release(green);obs_source_release(blue);obs_source_release(red);
 for(int i=0;i<300&&producer_set_v2_live_groups();i++)usleep(10000);require(!producer_set_v2_live_groups(),"effect texture/group resources released");
 return @{@"ok":@YES,@"circleProgress":@[@0,@0.5,@1],@"wipe":@YES,@"inverse":@YES,@"backdrop":@YES,@"foregroundSharp":@YES,@"translucentAlpha":@YES,@"sceneReplacements":@240,@"colorContexts":@2,@"nativeAnimationTrack":@YES,@"cachedReset":@YES,@"remainingGroups":@(producer_set_v2_live_groups())};
}
