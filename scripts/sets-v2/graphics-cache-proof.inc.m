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
static NSDictionary *graphics_cache_proof(NSString *app,NSString *out){
 load_plugin(app,@"obs-browser");obs_post_load_modules();
 obs_scene_t *room=obs_scene_create_private("Graphics cache proof");obs_source_t *source=obs_scene_get_source(room),*camera=solid(200,200,0,1,0,true);
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

 sets_v2_rust_release(owner);obs_set_output_source(0,NULL);obs_source_release(camera);obs_scene_release(room);
 for(int i=0;i<300&&producer_set_v2_live_groups();i++)usleep(10000);require(!producer_set_v2_live_groups(),"pooled graphics ownership released");
 return @{@"ok":@YES,@"graphicsLayerCounts":counts,@"cameraPreserved":@YES,@"switches":@60,@"outputFrames":@(atomic_load(&samples.frames)),@"missingGraphicsFrames":@(atomic_load(&samples.missing)),@"remainingGroups":@(producer_set_v2_live_groups())};
}
