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
 obs_set_output_source(0,source);void *owner=sets_v2_rust_attach(room,640,360);require(owner!=NULL,"cache owner");
 NSMutableArray *counts=[NSMutableArray array];
 for(int i=0;i<3;i++){
  NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[NSString stringWithFormat:@"plan-%d.json",i]]] options:0 error:nil];require(plan!=nil,"graphics plan");
  NSNumber *revision=@(i*2+1);NSString *key=[NSString stringWithFormat:@"view-%d",i];
  rust_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":revision,@"key":key,@"plan":plan},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<800;poll++){state=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"cachedKeys"] containsObject:key])break;usleep(20000);}
  require([state[@"cachedKeys"] containsObject:key],"graphics cached and painted");[counts addObject:state[@"graphicsLayers"]];
  NSNumber *takeRevision=@(i*2+2);rust_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":takeRevision,@"key":key,@"plan":plan},camera,true);rust_call(owner,@{@"op":@"take",@"generation":@7,@"revision":takeRevision,@"durationMs":@0,@"mode":@"dissolve"},camera,true);
  for(int poll=0;poll<400;poll++){state=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"renderedRevision"] isEqual:takeRevision])break;usleep(20000);}require([state[@"renderedRevision"] isEqual:takeRevision],"cached take presented");
  NSData *frame=capture(source,640,360,640,360);color(frame,640,450,120,0,255,0,255,"shared camera stays live");
 }
 // Drop complete scene snapshots while retaining their bounded immutable paint.
 NSDictionary *evicted=rust_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
 require([evicted[@"cachedKeys"] count]==0&&[evicted[@"graphicsLayers"] intValue]==3,"paint outlives full scene snapshots");
 NSMutableArray *rehydrate=[NSMutableArray array];
 for(int i=0;i<2;i++){
  NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[NSString stringWithFormat:@"plan-%d.json",i]]] options:0 error:nil];NSString *key=[NSString stringWithFormat:@"view-%d",i];
  double started=[NSDate timeIntervalSinceReferenceDate];
  rust_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(7+i),@"key":key,@"plan":plan},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<800;poll++){state=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"cachedKeys"] containsObject:key])break;usleep(10000);}
  require([state[@"cachedKeys"] containsObject:key]&&[state[@"graphicsLayers"] intValue]==3,"rehydration creates no new browser painters");
  double ms=([NSDate timeIntervalSinceReferenceDate]-started)*1000;[rehydrate addObject:@(ms)];require(ms<750,"paint-warm scene rebuild stays responsive");
 }
 fprintf(stderr,"GRAPHICS COUNTS %s\n",counts.description.UTF8String);
 require([counts isEqual:@[@2,@3,@3]],"unchanged header and repeated content reuse exact raster sources");
 struct continuity_samples samples={0};samples.csv=fopen([out stringByAppendingPathComponent:@"continuity.csv"].UTF8String,"w");require(samples.csv!=NULL,"frame report");
 const struct continuity_scale scale={6,640,360,2,0};
 obs_add_raw_video_callback(&scale,continuity_frame,&samples);usleep(300000);
 for(int turn=0;turn<60;turn++){
  int i=turn%2;NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[NSString stringWithFormat:@"plan-%d.json",i]]] options:0 error:nil];
  NSNumber *revision=@(20+turn);NSString *key=[NSString stringWithFormat:@"view-%d",i];
  rust_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":revision,@"key":key,@"plan":plan},camera,true);
  rust_call(owner,@{@"op":@"take",@"generation":@7,@"revision":revision,@"durationMs":@0,@"mode":@"dissolve"},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<400;poll++){state=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"renderedRevision"] isEqual:revision])break;usleep(10000);}require([state[@"renderedRevision"] isEqual:revision],"continuous take receipt");usleep(75000);
 }
 usleep(300000);obs_remove_raw_video_callback(continuity_frame,&samples);fclose(samples.csv);
 fprintf(stderr,"CONTINUITY %u frames, %u missing graphics\n",atomic_load(&samples.frames),atomic_load(&samples.missing));
 require(atomic_load(&samples.frames)>100&&atomic_load(&samples.missing)==0,"every actual output frame retains persistent graphics during 60 takes");

 // Forty-five snapshots share the same large immutable header. Native
 // placement surfaces remain charged per scene, paint surfaces only once.
 rust_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
 NSUInteger standaloneBytes=0,residentBytes=0;
 for(int i=0;i<45;i++){
  NSMutableDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:@"plan-0.json"]] options:NSJSONReadingMutableContainers error:nil];
  NSMutableDictionary *header=plan[@"root"][@"children"][0];header[@"bounds"][@"width"]=@1600;header[@"bounds"][@"height"]=@900;
  plan[@"root"][@"children"][2][@"properties"][@"text"]=[NSString stringWithFormat:@"SHARED %d",i];
  NSString *key=[NSString stringWithFormat:@"shared-%d",i];
  rust_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(100+i),@"key":key,@"plan":plan},camera,true);
  NSDictionary *state=nil;for(int poll=0;poll<800;poll++){state=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([state[@"cachedKeys"] containsObject:key])break;usleep(10000);}
  require([state[@"cachedKeys"] containsObject:key],"shared snapshot prepared under unchanged memory limit");
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
  rust_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
  rust_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(200+i),@"key":key,@"plan":plan},camera,true);
  for(int poll=0;poll<800;poll++){pressure=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([pressure[@"cachedKeys"] containsObject:key])break;usleep(20000);}
  require([pressure[@"cachedKeys"] containsObject:key],"pressure scene painted");
  pressure=rust_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[],@"assetIds":@[]},camera,true);
  NSUInteger spare=[pressure[@"spareGraphicsBytes"] unsignedIntegerValue];peakSpare=MAX(peakSpare,spare);require(spare<=64*1024*1024,"spare paint LRU byte bound");
 }
 require([pressure[@"graphicsLayers"] intValue]<11,"old unleased paint evicted under pressure");
 NSData *stillLive=capture(source,640,360,640,360);color(stillLive,640,450,120,0,255,0,255,"live source survives spare paint eviction");
 require(producer_set_v2_group_effect_compilations()==1,"all simultaneous groups share one compositor shader program");
 sets_v2_rust_release(owner);obs_set_output_source(0,NULL);obs_source_release(camera);obs_scene_release(room);
 for(int i=0;i<300&&producer_set_v2_live_groups();i++)usleep(10000);require(!producer_set_v2_live_groups(),"pooled graphics ownership released");
 return @{@"ok":@YES,@"sharedSnapshotCount":@45,@"sharedSnapshotBytes":@(residentBytes),@"standaloneSnapshotBytes":@(standaloneBytes),@"graphicsLayerCounts":counts,@"rehydrateMs":rehydrate,@"peakSpareGraphicsBytes":@(peakSpare),@"lruEvictionVerified":@YES,@"cameraPreserved":@YES,@"switches":@60,@"outputFrames":@(atomic_load(&samples.frames)),@"missingGraphicsFrames":@(atomic_load(&samples.missing)),@"remainingGroups":@(producer_set_v2_live_groups())};
}
