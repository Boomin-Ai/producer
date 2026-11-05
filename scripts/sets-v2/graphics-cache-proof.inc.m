struct continuity_video_data {uint8_t *data[8];uint32_t linesize[8];uint64_t timestamp;};
struct continuity_scale {int format;uint32_t width,height;int range,colorspace;};
OBS_IMPORT void obs_add_raw_video_callback(const struct continuity_scale *,void (*)(void *,struct continuity_video_data *),void *);
OBS_IMPORT void obs_remove_raw_video_callback(void (*)(void *,struct continuity_video_data *),void *);
struct continuity_samples {atomic_uint frames,missing;FILE *csv;};
static void continuity_frame(void *data,struct continuity_video_data *frame){
 struct continuity_samples *samples=data;unsigned white=0;
 for(unsigned y=5;y<55;y+=2)for(unsigned x=5;x<400;x+=2){const uint8_t *p=frame->data[0]+y*frame->linesize[0]+x*4;if(p[0]>190&&p[1]>190&&p[2]>190)white++;}
 unsigned index=atomic_fetch_add(&samples->frames,1);if(!white)atomic_fetch_add(&samples->missing,1);
 fprintf(samples->csv,"%u,%llu,%u\n",index,(unsigned long long)frame->timestamp,white);
}
static NSUInteger raster_peak_painting, raster_status_samples;
static const uint8_t raster_queue_colors[5][3]={{34,68,102},{102,68,34},{34,102,68},{102,34,68},{68,34,102}};
extern size_t producer_set_v2_raster_probe_live_inputs(void);
extern size_t producer_set_v2_raster_probe_tracked_inputs(void);
extern size_t producer_set_v2_raster_probe_input_overflow(void);
static void raster_inputs_retired(void){
 // Weak observers retain no CEF source. Drain OBS's asynchronous destruction
 // queue before claiming source retirement; OS child processes can close later.
 obs_wait_for_destroy_queue();
 require(!producer_set_v2_raster_probe_input_overflow(),"raster input lifetime observers did not overflow");
 require(producer_set_v2_raster_probe_tracked_inputs()>0,"raster lifetime proof observed actual paint inputs");
 require(!producer_set_v2_raster_probe_live_inputs(),"completed snapshots retain no live OBS paint input sources");
}
static NSDictionary *raster_checked_call(void *owner,NSDictionary *action,
                                         obs_source_t *camera,bool expected_ok){
 NSDictionary *state=rust_call(owner,action,camera,expected_ok);
 if(!expected_ok)return state;
 for(NSString *key in @[@"graphicsPainting",@"graphicsPending",@"graphicsSnapshots",@"graphicsLayers",@"graphicsCreations",@"quarantineCount"])
  require([state[key] isKindOfClass:NSNumber.class]&&[state[key] longLongValue]>=0,"native raster status is explicit and nonnegative");
 require([state[@"copyBlocked"] isKindOfClass:NSNumber.class]&&![state[@"copyBlocked"] boolValue],"healthy cache proof never enters the terminal GPU copy block");
 require([state[@"quarantineCount"] unsignedIntegerValue]==0,"healthy cache proof retains no quarantined GPU/input leases");
 NSUInteger painting=[state[@"graphicsPainting"] unsignedIntegerValue];
 require(painting<=2,"one output owns at most two active CEF painting leases");
 require([state[@"graphicsSnapshots"] unsignedIntegerValue]<=[state[@"graphicsLayers"] unsignedIntegerValue],"ready raster snapshots never exceed descriptor count");
 raster_peak_painting=MAX(raster_peak_painting,painting);raster_status_samples++;
 return state;
}
static void raster_settled(NSDictionary *state){
 require([state[@"graphicsPainting"] unsignedIntegerValue]==0&&[state[@"graphicsPending"] unsignedIntegerValue]==0,"ready cache retains no painting or queued immutable documents");
 require([state[@"graphicsSnapshots"] unsignedIntegerValue]==[state[@"graphicsLayers"] unsignedIntegerValue],"every retained raster descriptor owns its completed snapshot");
 raster_inputs_retired();
}
static NSDictionary *raster_wait_cached(void *owner,NSString *key,obs_source_t *camera){
 NSDictionary *state=nil;
 for(int poll=0;poll<800;poll++){
  state=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);
  if([state[@"cachedKeys"] containsObject:key])break;
  usleep(20000);
 }
 require([state[@"cachedKeys"] containsObject:key],"queued raster draft reaches its real cached-ready receipt");
 raster_settled(state);return state;
}
static NSMutableDictionary *raster_queue_plan(NSDictionary *base,NSString *prefix){
 NSMutableDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSJSONSerialization dataWithJSONObject:base options:0 error:nil] options:NSJSONReadingMutableContainers error:nil];
 require(plan!=nil,"clone raster queue fixture");
 NSDictionary *text=plan[@"root"][@"children"][0],*camera=plan[@"root"][@"children"][1];
 NSMutableArray *children=[NSMutableArray array];
 // Consecutive graphics nodes are one HTML batch. Separate each distinct
 // painter with an ordinary capture placement, forcing five actual rasters
 // inside ONE draft instead of accidentally testing one five-label document.
 for(int i=0;i<5;i++){
  NSMutableDictionary *label=[text mutableCopy],*properties=[text[@"properties"] mutableCopy],*paint=[text[@"paint"] mutableCopy];
  require(paint!=nil,"compiled queue text has an explicit paint style");
  label[@"id"]=[NSString stringWithFormat:@"%@-text-%d",prefix,i];
  label[@"bounds"]=@{@"x":@0,@"y":@(i*48),@"width":@320,@"height":@40};
  properties[@"text"]=[NSString stringWithFormat:@"%@ PAINT %d",prefix,i];label[@"properties"]=properties;
  paint[@"background"]=[NSString stringWithFormat:@"#%02x%02x%02x",raster_queue_colors[i][0],raster_queue_colors[i][1],raster_queue_colors[i][2]];label[@"paint"]=paint;[children addObject:label];
  NSMutableDictionary *separator=[camera mutableCopy];separator[@"id"]=[NSString stringWithFormat:@"%@-capture-%d",prefix,i];
  separator[@"bounds"]=@{@"x":@500,@"y":@(70+i*30),@"width":@20,@"height":@20};[children addObject:separator];
 }
 plan[@"root"][@"children"]=children;return plan;
}
static NSDictionary *raster_queue_proof(NSString *out,obs_source_t *camera,
                                       void *live_owner,obs_source_t *live_source){
 NSDictionary *base=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"plan-0.json"]] options:0 error:nil];
 require(base!=nil,"queue proof uses the real compiled graphics plan");
 NSMutableDictionary *plan=raster_queue_plan(base,@"QUEUE");
 obs_scene_t *room=obs_scene_create_private("Raster slot queue proof");
 require(room!=NULL,"independent raster queue room");void *owner=sets_v2_rust_attach(room,640,360);require(owner!=NULL,"independent raster queue owner");
 // Static capture makes the same-owner before/after image comparison exact;
 // the separate main owner continues exercising the animated live camera.
 obs_source_t *queue_camera=solid(200,200,0,1,0,false);
 NSDictionary *live_before=raster_checked_call(live_owner,@{@"op":@"status",@"generation":@7},camera,true);
 NSNumber *live_revision=live_before[@"renderedRevision"];
 size_t queue_inputs_before=producer_set_v2_raster_probe_tracked_inputs();
 raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@1,@"key":@"five-painters",@"plan":plan},queue_camera,true);
 NSDictionary *ready=raster_wait_cached(owner,@"five-painters",queue_camera);
 require([ready[@"graphicsLayers"] unsignedIntegerValue]==5&&[ready[@"graphicsSnapshots"] unsignedIntegerValue]==5,"five separate painters all drain through the two-slot queue");
 require([ready[@"graphicsCreations"] unsignedIntegerValue]==5,"each unique raster starts one painter");
 require(producer_set_v2_raster_probe_tracked_inputs()==queue_inputs_before+5,"weak lifetime ledger observes all five actual CEF paint inputs");
 NSNumber *created=ready[@"graphicsCreations"];
 NSDictionary *evicted=raster_checked_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},queue_camera,true);
 require([evicted[@"cachedKeys"] count]==0,"queue proof removes complete scene snapshots");raster_settled(evicted);
 raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@2,@"key":@"five-painters-rehydrated",@"plan":plan},queue_camera,true);
 NSDictionary *rehydrated=raster_wait_cached(owner,@"five-painters-rehydrated",queue_camera);
 require([rehydrated[@"graphicsCreations"] isEqual:created],"rehydrating five owned GPU rasters starts no CEF painters");
 raster_checked_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":@3,@"key":@"five-painters-rehydrated",@"plan":plan},queue_camera,true);
 raster_checked_call(owner,@{@"op":@"take",@"generation":@7,@"revision":@3,@"durationMs":@0,@"mode":@"dissolve"},queue_camera,true);
 obs_source_t *queue_source=obs_scene_get_source(room);NSDictionary *presented=nil;
 for(int poll=0;poll<400;poll++){
  // This owner is deliberately off the real output. Render its source to
  // exercise the normal take receipt without replacing the live owner's room.
  capture(queue_source,640,360,640,360);
  presented=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},queue_camera,true);
  if([presented[@"renderedRevision"] isEqual:@3])break;
  usleep(10000);
 }
 require([presented[@"renderedRevision"] isEqual:@3],"queue owner presents its completed raster graph");
 NSData *queue_before_cancel=capture(queue_source,640,360,640,360);
 // Equality with a blank pre-cancel frame would prove nothing. Check a known
 // background pixel in each separately painted band before comparing images.
 for(int i=0;i<5;i++)color(queue_before_cancel,640,310,i*48+20,raster_queue_colors[i][0],raster_queue_colors[i][1],raster_queue_colors[i][2],255,"each queued raster has its distinct visible pixels before cancellation");
 // Cancel a fresh >2-layer candidate before taking it. It may already have
 // copied a prefix, but it must not keep painting unleased queued documents.
 NSMutableDictionary *cancelled=raster_queue_plan(base,@"CANCEL");
 NSDictionary *before_cancel=raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@4,@"key":@"cancel-five",@"plan":cancelled},queue_camera,true);
 require([before_cancel[@"graphicsPending"] unsignedIntegerValue]>=3,"cancellation fixture actually contains queued unstarted painters");
 raster_checked_call(owner,@{@"op":@"cancel",@"generation":@7,@"revision":@4},queue_camera,true);
 NSDictionary *after_cancel=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},queue_camera,true);raster_settled(after_cancel);
 require(![after_cancel[@"cachedKeys"] containsObject:@"cancel-five"]&&[after_cancel[@"cachedKeys"] containsObject:@"five-painters-rehydrated"],"cancelled candidate never becomes cached-ready or evicts the previous snapshot");
 require([after_cancel[@"renderedRevision"] isEqual:@3],"cancellation preserves the same owner's rendered revision");
 require([capture(queue_source,640,360,640,360) isEqualToData:queue_before_cancel],"cancellation preserves every pixel of the same owner's current raster output");
 NSNumber *cancel_creations=after_cancel[@"graphicsCreations"];
 for(int poll=0;poll<5;poll++){
  after_cancel=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},queue_camera,true);raster_settled(after_cancel);
  require([after_cancel[@"graphicsCreations"] isEqual:cancel_creations],"unleased queued painters never start on later polls");
 }
 NSDictionary *live_after=raster_checked_call(live_owner,@{@"op":@"status",@"generation":@7},camera,true);
 require([live_after[@"renderedRevision"] isEqual:live_revision],"another output's preparation and cancellation preserve the live revision");
 NSData *frame=capture(live_source,640,360,640,360);color(frame,640,450,120,0,255,0,255,"live camera survives queued-raster cancellation");
 sets_v2_rust_release(owner);obs_scene_release(room);obs_source_release(queue_camera);obs_wait_for_destroy_queue();
 return @{@"uniqueLayers":@5,@"snapshotsReady":@5,@"actualPaintInputsObserved":@5,@"rehydratedWithoutNewPainters":@YES,@"cancelledQueueRetired":@YES,@"sameOwnerCurrentOutputPreserved":@YES,@"liveOutputPreserved":@YES};
}
static NSDictionary *raster_thin_cef_proof(NSString *out){
 NSMutableDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"plan-0.json"]] options:NSJSONReadingMutableContainers error:nil];
 require(plan!=nil,"thin CEF proof uses the actual compiled plan");
 NSDictionary *capture_node=plan[@"root"][@"children"][1];
 const unsigned widths[3]={1,2,5},positions[3]={10,30,50};
 const uint8_t colors[3][3]={{136,96,46},{72,144,112},{64,128,192}};
 NSArray *graphic_resources=@[@"graphic:navy",@"graphic:gold",@"graphic:pink"];
 NSMutableArray *resources=[plan[@"resources"] mutableCopy];[resources addObjectsFromArray:graphic_resources];plan[@"resources"]=resources;
 NSMutableArray *children=[NSMutableArray array];
 for(int i=0;i<3;i++){
  NSString *paint=[NSString stringWithFormat:@"#%02x%02x%02x",colors[i][0],colors[i][1],colors[i][2]];
  [children addObject:@{@"id":[NSString stringWithFormat:@"thin-cef-%d",i],@"kind":@"graphic",@"resource":graphic_resources[i],@"bounds":@{@"x":@(positions[i]),@"y":@10,@"width":@(widths[i]),@"height":@17},@"properties":@{@"opacity":@1,@"background":paint},@"children":@[]}];
  // A capture between each graphic prevents Arena from combining the three
  // thin authored widths into one wide HTML batch. Canvas/density stay 1:1.
  NSMutableDictionary *separator=[capture_node mutableCopy];separator[@"id"]=[NSString stringWithFormat:@"thin-cef-separator-%d",i];
  separator[@"bounds"]=@{@"x":@620,@"y":@(320+i*5),@"width":@1,@"height":@1};[children addObject:separator];
 }
 plan[@"root"][@"children"]=children;
 require([plan[@"root"][@"bounds"][@"width"] isEqual:@640]&&[plan[@"root"][@"bounds"][@"height"] isEqual:@360],"thin fixture preserves the 1:1 authored canvas");
 obs_scene_t *room=obs_scene_create_private("Opaque thin CEF fence proof");require(room!=NULL,"thin CEF room");
 obs_source_t *background=solid(640,360,0,0,0,false),*camera=solid(1,1,0,1,0,false);
 require(obs_scene_add(room,background)!=NULL,"explicit opaque background below thin Set");
 void *owner=sets_v2_rust_attach(room,640,360);require(owner!=NULL,"thin CEF output owner");
 size_t observed_before=producer_set_v2_raster_probe_tracked_inputs();
 raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@1,@"key":@"thin-cef-widths",@"plan":plan},camera,true);
 NSDictionary *ready=raster_wait_cached(owner,@"thin-cef-widths",camera);
 require([ready[@"graphicsLayers"] unsignedIntegerValue]==3&&[ready[@"graphicsSnapshots"] unsignedIntegerValue]==3&&[ready[@"graphicsCreations"] unsignedIntegerValue]==3,"three sub-six-pixel CEF documents become three completed GPU rasters");
 require(producer_set_v2_raster_probe_tracked_inputs()==observed_before+3,"all three thin fences were read from actual CEF input sources");
 raster_checked_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":@2,@"key":@"thin-cef-widths",@"plan":plan},camera,true);
 raster_checked_call(owner,@{@"op":@"take",@"generation":@7,@"revision":@2,@"durationMs":@0,@"mode":@"dissolve"},camera,true);
 obs_source_t *source=obs_scene_get_source(room);NSDictionary *presented=nil;
 for(int poll=0;poll<400;poll++){
  capture(source,640,360,640,360);
  presented=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);
  if([presented[@"renderedRevision"] isEqual:@2])break;
  usleep(10000);
 }
 require([presented[@"renderedRevision"] isEqual:@2],"actual thin CEF snapshots reach output after their browsers retire");raster_settled(presented);
 NSData *frame=capture(source,640,360,640,360);
 for(int i=0;i<3;i++){
  for(unsigned y=10;y<27;y++)for(unsigned x=0;x<widths[i];x++)
   color(frame,640,positions[i]+x,y,colors[i][0],colors[i][1],colors[i][2],255,"thin authored pixels survive actual CEF rasterization");
  color(frame,640,positions[i]-1,18,0,0,0,255,"thin left padding stays opaque background");
  color(frame,640,positions[i]+widths[i],18,0,0,0,255,"thin right viewport padding is not authored output");
  color(frame,640,positions[i],9,0,0,0,255,"thin top extent stays opaque background");
  color(frame,640,positions[i],27,0,0,0,255,"six-pixel private CEF receipt row never leaks into output");
 }
 sets_v2_rust_release(owner);obs_scene_release(room);obs_source_release(camera);obs_source_release(background);raster_inputs_retired();
 return @{@"physicalAuthoredWidths":@[@1,@2,@5],@"physicalAuthoredHeight":@17,@"density":@1,@"actualCefPaintInputsObserved":@3,@"sixPixelFencesAccepted":@YES,@"authoredPixelsCorrect":@YES,@"privatePaddingAndFenceExcluded":@YES,@"paintInputsRetiredBeforeOutputRead":@YES,@"outsideRgba":@[@0,@0,@0,@255]};
}
extern obs_source_t *producer_shader_create(const char *,const char *);
extern void producer_shader_frame(obs_source_t *,float,float,float,float);
extern size_t producer_shader_effect_compilations(void);
static void shader_program_proof(void){
 const char *kernel=
  "uniform float4x4 ViewProj;uniform float4 paletteA;uniform float intensity;uniform float alpha;"
  "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};V VS(V v){V o;o.pos=mul(float4(v.pos.xyz,1),ViewProj);o.uv=v.uv;return o;}"
  "float4 PS(V v):TARGET{return float4(paletteA.rgb*intensity,alpha);}"
  "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}";
 const char *red="{\"width\":32,\"height\":32,\"effect\":\"edgeGlow\",\"intensity\":1,\"scale\":1,\"opacity\":1,\"colorA\":\"#ff0000\",\"colorB\":\"#000000\",\"colorC\":\"#000000\"}";
 const char *green="{\"width\":32,\"height\":32,\"effect\":\"edgeGlow\",\"intensity\":1,\"scale\":1,\"opacity\":1,\"colorA\":\"#00ff00\",\"colorB\":\"#000000\",\"colorC\":\"#000000\"}";
 size_t before=producer_shader_effect_compilations();
 obs_source_t *a=producer_shader_create(red,kernel),*b=producer_shader_create(green,kernel);require(a&&b,"pooled shader sources created");
 require(producer_shader_effect_compilations()==before+2,"one kernel and one presentation program compiled for both instances");
 color(capture(a,32,32,32,32),32,16,16,255,0,0,255,"first source owns red palette");
 color(capture(b,32,32,32,32),32,16,16,0,255,0,255,"second source owns green palette");
 producer_shader_frame(a,1,.5,1,1);
 color(capture(a,32,32,32,32),32,16,16,128,0,0,255,"changed first instance keeps its own uniforms");
 color(capture(b,32,32,32,32),32,16,16,0,255,0,255,"first instance update preserves second texture");
 producer_shader_frame(b,2,.5,1,1);
 color(capture(b,32,32,32,32),32,16,16,0,128,0,255,"second redraw restores its own palette");
 obs_source_release(a);obs_source_release(b);obs_wait_for_destroy_queue();
 obs_source_t *again=producer_shader_create(red,kernel);require(again!=NULL,"shader pool recreated after teardown");
 require(producer_shader_effect_compilations()==before+4,"last lease releases both compiled programs");
 obs_source_release(again);obs_wait_for_destroy_queue();
}
static NSDictionary *graphics_cache_proof(NSString *app,NSString *out){
 raster_peak_painting=0;raster_status_samples=0;
 size_t group_programs_before=producer_set_v2_group_effect_compilations();
 shader_program_proof();
 require(producer_set_v2_surfaces_warm(NULL,0),"empty warm batch");
 require(!producer_set_v2_surfaces_warm(NULL,1),"missing warm batch sources rejected");
 load_plugin(app,@"obs-browser");obs_post_load_modules();
 obs_scene_t *room=obs_scene_create_private("Graphics cache proof");obs_source_t *source=obs_scene_get_source(room),*camera=solid(200,200,0,1,0,true);
 obs_source_t *marker_sources[]={camera};uint32_t marker_rows[]={0};
 require(producer_set_v2_surface_markers(NULL,NULL,0),"empty marker batch");
 require(!producer_set_v2_surface_markers(NULL,NULL,1),"missing marker batch arrays rejected");
 require(!producer_set_v2_surface_markers(marker_sources,marker_rows,17),"oversized marker batch rejected");
 require(!producer_set_v2_surface_markers(marker_sources,marker_rows,1),"unpainted marker pixels rejected");
 // Exercise actual GPU pixel receipts independently of browser dimensions.
 obs_source_t *painted=solid(2,2,1.f/255.f,254.f/255.f,3.f/255.f,false);
 obs_source_t *progress_sources[]={painted,camera,painted};uint32_t progress_rows[]={0,0,0};size_t verified=99;
 require(producer_set_v2_surface_marker_progress(progress_sources,progress_rows,3,&verified)&&verified==1,"retain actual marker prefix before an unpainted source");
 obs_source_t *ready_suffix[]={painted,painted};
 require(producer_set_v2_surface_marker_progress(ready_suffix,progress_rows+1,2,&verified)&&verified==2,"remaining actual marker suffix can complete independently");
 require(producer_set_v2_surface_markers(ready_suffix,progress_rows+1,2),"legacy marker API still requires the complete batch");
 verified=99;require(!producer_set_v2_surface_marker_progress(NULL,NULL,1,&verified)&&verified==0,"invalid progress arrays produce no receipts");
 verified=99;require(!producer_set_v2_surface_marker_progress(progress_sources,progress_rows,17,&verified)&&verified==0,"oversized progress request produces no receipts");
 obs_source_t *invalid_progress[]={painted,NULL};verified=99;
 require(!producer_set_v2_surface_marker_progress(invalid_progress,progress_rows,2,&verified)&&verified==0,"later missing source invalidates all progress");
 require(producer_set_v2_surface_marker_progress(NULL,NULL,0,&verified)&&verified==0,"empty progress batch needs no pixel receipt");
 obs_source_release(painted);
 obs_set_output_source(0,source);void *owner=sets_v2_rust_attach(room,640,360);require(owner!=NULL,"cache owner");
 NSMutableArray *counts=[NSMutableArray array];
 for(int i=0;i<3;i++){
  NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[NSString stringWithFormat:@"plan-%d.json",i]]] options:0 error:nil];require(plan!=nil,"graphics plan");
  NSNumber *revision=@(i*2+1);NSString *key=[NSString stringWithFormat:@"view-%d",i];
  raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":revision,@"key":key,@"plan":plan},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<800;poll++){state=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"cachedKeys"] containsObject:key])break;usleep(20000);}
  require([state[@"cachedKeys"] containsObject:key],"graphics cached and painted");raster_settled(state);[counts addObject:state[@"graphicsLayers"]];
  NSNumber *takeRevision=@(i*2+2);raster_checked_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":takeRevision,@"key":key,@"plan":plan},camera,true);raster_checked_call(owner,@{@"op":@"take",@"generation":@7,@"revision":takeRevision,@"durationMs":@0,@"mode":@"dissolve"},camera,true);
  for(int poll=0;poll<400;poll++){state=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"renderedRevision"] isEqual:takeRevision])break;usleep(20000);}require([state[@"renderedRevision"] isEqual:takeRevision],"cached take presented");
  NSData *frame=capture(source,640,360,640,360);color(frame,640,450,120,0,255,0,255,"shared camera stays live");
 }
 // Drop complete scene snapshots while retaining their bounded immutable paint.
 NSDictionary *evicted=raster_checked_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
 require([evicted[@"cachedKeys"] count]==0&&[evicted[@"graphicsLayers"] intValue]==3,"paint outlives full scene snapshots");
 raster_settled(evicted);NSNumber *rehydrate_creations=evicted[@"graphicsCreations"];
 size_t rehydrate_observed_inputs=producer_set_v2_raster_probe_tracked_inputs();
 NSMutableArray *rehydrate=[NSMutableArray array];
 for(int i=0;i<2;i++){
  NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[NSString stringWithFormat:@"plan-%d.json",i]]] options:0 error:nil];NSString *key=[NSString stringWithFormat:@"view-%d",i];
  double started=[NSDate timeIntervalSinceReferenceDate];
  raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(7+i),@"key":key,@"plan":plan},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<800;poll++){state=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"cachedKeys"] containsObject:key])break;usleep(10000);}
  require([state[@"cachedKeys"] containsObject:key]&&[state[@"graphicsLayers"] intValue]==3,"rehydration reuses the same raster descriptors");raster_settled(state);
  require([state[@"graphicsCreations"] isEqual:rehydrate_creations],"warm scene rehydration starts no CEF painters");
  require(producer_set_v2_raster_probe_tracked_inputs()==rehydrate_observed_inputs,"rehydration uses no new observed paint input documents");
  double ms=([NSDate timeIntervalSinceReferenceDate]-started)*1000;[rehydrate addObject:@(ms)];require(ms<750,"paint-warm scene rebuild stays responsive");
 }
 fprintf(stderr,"GRAPHICS COUNTS %s\n",counts.description.UTF8String);
 require([counts isEqual:@[@2,@3,@3]],"unchanged header and repeated content reuse exact raster sources");
 NSDictionary *queue_proof=raster_queue_proof(out,camera,owner,source);
 NSDictionary *thin_cef_proof=raster_thin_cef_proof(out);
 NSNumber *switch_creations=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true)[@"graphicsCreations"];
 size_t switch_observed_inputs=producer_set_v2_raster_probe_tracked_inputs();
 struct continuity_samples samples={0};samples.csv=fopen([out stringByAppendingPathComponent:@"continuity.csv"].UTF8String,"w");require(samples.csv!=NULL,"frame report");
 const struct continuity_scale scale={6,640,360,2,0};
 obs_add_raw_video_callback(&scale,continuity_frame,&samples);usleep(300000);
 for(int turn=0;turn<60;turn++){
  int i=turn%2;NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[NSString stringWithFormat:@"plan-%d.json",i]]] options:0 error:nil];
  NSNumber *revision=@(20+turn);NSString *key=[NSString stringWithFormat:@"view-%d",i];
  raster_checked_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":revision,@"key":key,@"plan":plan},camera,true);
  raster_checked_call(owner,@{@"op":@"take",@"generation":@7,@"revision":revision,@"durationMs":@0,@"mode":@"dissolve"},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<400;poll++){state=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"renderedRevision"] isEqual:revision])break;usleep(10000);}require([state[@"renderedRevision"] isEqual:revision],"continuous take receipt");usleep(75000);
 }
 usleep(300000);obs_remove_raw_video_callback(continuity_frame,&samples);fclose(samples.csv);
 fprintf(stderr,"CONTINUITY %u frames, %u missing graphics\n",atomic_load(&samples.frames),atomic_load(&samples.missing));
 require(atomic_load(&samples.frames)>100&&atomic_load(&samples.missing)==0,"every actual output frame retains persistent graphics during 60 takes");
 NSDictionary *after_switches=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);raster_settled(after_switches);
 require([after_switches[@"graphicsCreations"] isEqual:switch_creations],"sixty cached takes use GPU rasters without recreating CEF painters");
 require(producer_set_v2_raster_probe_tracked_inputs()==switch_observed_inputs,"sixty cached takes use no new observed paint input documents");

 // Forty-five snapshots share the same large immutable header. Native
 // placement surfaces remain charged per scene, paint surfaces only once.
 raster_checked_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
 NSUInteger standaloneBytes=0,residentBytes=0;
 for(int i=0;i<45;i++){
  NSMutableDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"plan-0.json"]] options:NSJSONReadingMutableContainers error:nil];
  NSMutableDictionary *header=plan[@"root"][@"children"][0];header[@"bounds"][@"width"]=@1600;header[@"bounds"][@"height"]=@900;
  plan[@"root"][@"children"][2][@"properties"][@"text"]=[NSString stringWithFormat:@"SHARED %d",i];
  NSString *key=[NSString stringWithFormat:@"shared-%d",i];
  raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(100+i),@"key":key,@"plan":plan},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<800;poll++){state=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"cachedKeys"] containsObject:key])break;usleep(10000);}
  require([state[@"cachedKeys"] containsObject:key],"shared snapshot prepared under unchanged memory limit");raster_settled(state);
  residentBytes=[state[@"cachedBytes"] unsignedIntegerValue];if(i==0)standaloneBytes=residentBytes;
 }
 require(standaloneBytes*45>768*1024*1024,"fixture exceeds budget if shared paint is charged repeatedly");
 require(residentBytes<=768*1024*1024,"actual unique resource charge respects existing budget");
 // Force the immutable paint pool beyond its spare-byte cap. Eviction must
 // remove only unleased LRU painters, without touching the presented output.
 NSMutableArray *warmKeys=[NSMutableArray array];NSUInteger peakSpare=0;NSDictionary *pressure=nil;
 for(int i=0;i<9;i++){
  NSMutableDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"plan-0.json"]] options:NSJSONReadingMutableContainers error:nil];
  NSMutableDictionary *caption=plan[@"root"][@"children"][2];caption[@"bounds"][@"width"]=@1600;caption[@"bounds"][@"height"]=@900;caption[@"properties"][@"text"]=[NSString stringWithFormat:@"LARGE %d",i];
  NSString *key=[NSString stringWithFormat:@"pressure-%d",i];[warmKeys addObject:key];
  raster_checked_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
  raster_checked_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(200+i),@"key":key,@"plan":plan},camera,true);
  for(int poll=0;poll<800;poll++){pressure=raster_checked_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([pressure[@"cachedKeys"] containsObject:key])break;usleep(20000);}
  require([pressure[@"cachedKeys"] containsObject:key],"pressure scene painted");raster_settled(pressure);
  pressure=raster_checked_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
  NSUInteger spare=[pressure[@"spareGraphicsBytes"] unsignedIntegerValue];peakSpare=MAX(peakSpare,spare);require(spare<=64*1024*1024,"spare paint LRU byte bound");
 }
 require([pressure[@"graphicsLayers"] intValue]<11,"old unleased paint evicted under pressure");
 NSData *stillLive=capture(source,640,360,640,360);color(stillLive,640,450,120,0,255,0,255,"live source survives spare paint eviction");
 require(producer_set_v2_group_effect_compilations()==group_programs_before+1,"all simultaneous groups share one compositor shader program");
 sets_v2_rust_release(owner);obs_set_output_source(0,NULL);obs_source_release(camera);obs_scene_release(room);
 for(int i=0;i<300&&producer_set_v2_live_groups();i++)usleep(10000);require(!producer_set_v2_live_groups(),"pooled graphics ownership released");
 raster_inputs_retired();
 return @{@"ok":@YES,@"sharedSnapshotCount":@45,@"sharedSnapshotBytes":@(residentBytes),@"standaloneSnapshotBytes":@(standaloneBytes),@"graphicsLayerCounts":counts,@"rehydrateMs":rehydrate,@"peakSpareGraphicsBytes":@(peakSpare),@"lruEvictionVerified":@YES,@"cameraPreserved":@YES,@"switches":@60,@"outputFrames":@(atomic_load(&samples.frames)),@"missingGraphicsFrames":@(atomic_load(&samples.missing)),@"remainingGroups":@(producer_set_v2_live_groups()),@"maximumObservedPaintingLeasesPerOwner":@(raster_peak_painting),@"rasterStatusObservations":@(raster_status_samples),@"paintingAfterReady":@0,@"pendingAfterReady":@0,@"cachedTakesCreatedPainters":@NO,@"queueProof":queue_proof,@"thinCefProof":thin_cef_proof,@"observedPaintInputsRetired":@YES,@"paintInputsTracked":@(producer_set_v2_raster_probe_tracked_inputs()),@"paintInputObserverOverflow":@(producer_set_v2_raster_probe_input_overflow()),@"inputLifetimeCoverage":@"Weak input observers begin at first capture; painters cancelled before any capture are covered by scheduler/source ownership review, not this weak ledger. OS child process exit is asynchronous."};
}
