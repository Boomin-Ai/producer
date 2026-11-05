/* Pure GPU ownership proof. No CEF, device capture, network or Producer IPC. */
#ifdef PRODUCER_SET_V2_PROBE
typedef struct obs_weak_source obs_weak_source_t;
OBS_IMPORT obs_weak_source_t *obs_source_get_weak_source(obs_source_t *);
OBS_IMPORT obs_source_t *obs_weak_source_get_source(obs_weak_source_t *);
OBS_IMPORT void obs_weak_source_release(obs_weak_source_t *);
OBS_IMPORT gs_texture_t *gs_texture_create(uint32_t, uint32_t, enum gs_color_format,
                                          uint32_t, const uint8_t **, uint32_t);
static atomic_size_t raster_inputs_live;
struct raster_input {
  uint32_t width, height, visible_width, visible_height;
  gs_texture_t *texture;
};
static const char *raster_input_name(void *unused){(void)unused;return "Immutable raster input proof";}
static uint32_t raster_input_width(void *data){return ((struct raster_input *)data)->width;}
static uint32_t raster_input_height(void *data){return ((struct raster_input *)data)->height;}
static void *raster_input_create(obs_data_t *settings,obs_source_t *source){
 (void)source;struct raster_input *input=calloc(1,sizeof(*input));if(!input)return NULL;
 input->width=obs_data_get_double(settings,"width");input->height=obs_data_get_double(settings,"height");
 input->visible_width=obs_data_get_double(settings,"visibleWidth");input->visible_height=input->height-1;
 atomic_fetch_add(&raster_inputs_live,1);return input;
}
static void raster_input_destroy(void *data){struct raster_input *input=data;obs_enter_graphics();gs_texture_destroy(input->texture);obs_leave_graphics();free(input);atomic_fetch_sub(&raster_inputs_live,1);}
static void raster_input_render(void *data,gs_effect_t *unused){
 (void)unused;struct raster_input *input=data;if(!input->texture)return;
 gs_effect_t *effect=obs_get_base_effect(OBS_EFFECT_DEFAULT);require(effect!=NULL,"engine default texture draw effect");
 gs_effect_set_texture(gs_effect_get_param_by_name(effect,"image"),input->texture);
 gs_technique_t *technique=gs_effect_get_technique(effect,"Draw");size_t passes=gs_technique_begin(technique);
 for(size_t i=0;i<passes;i++)if(gs_technique_begin_pass(technique,i)){gs_draw_sprite(input->texture,0,input->width,input->height);gs_technique_end_pass(technique);}gs_technique_end(technique);
}
static void raster_input_set_marker(obs_source_t *source,const uint8_t marker[18]){
 struct raster_input *input=obs_obj_get_data(source);require(input!=NULL,"owned input data");
 uint8_t *pixels=calloc((size_t)input->width*input->height,4);require(pixels!=NULL,"fixture RGBA allocation");
 for(uint32_t y=0;y<input->visible_height;y++)for(uint32_t x=0;x<input->visible_width;x++){
  uint8_t *p=pixels+((size_t)y*input->width+x)*4;
  if(x<input->visible_width*.25f&&y<input->visible_height*.35f)continue;
  if(x>input->visible_width*.65f){p[0]=26;p[1]=51;p[2]=77;p[3]=128;}
  else{p[0]=136;p[1]=96;p[2]=46;p[3]=255;}
 }
 for(int i=0;i<6;i++){uint8_t *p=pixels+((size_t)input->visible_height*input->width+i)*4;memcpy(p,marker+i*3,3);p[3]=255;}
 const uint8_t *planes[]={pixels};obs_enter_graphics();
 gs_texture_t *texture=gs_texture_create(input->width,input->height,GS_RGBA,1,planes,0);require(texture!=NULL,"upload encoded premultiplied RGBA fixture");
 gs_texture_t *old=input->texture;input->texture=texture;gs_texture_destroy(old);obs_leave_graphics();free(pixels);
}
static void register_raster_input(void){
 struct obs_source_info info={0};info.id="producer_raster_probe_input";info.type=OBS_SOURCE_TYPE_INPUT;info.output_flags=OBS_SOURCE_VIDEO|OBS_SOURCE_CUSTOM_DRAW;
 info.get_name=raster_input_name;info.create=raster_input_create;info.destroy=raster_input_destroy;info.get_width=raster_input_width;info.get_height=raster_input_height;info.video_render=raster_input_render;obs_register_source_s(&info,sizeof(info));
}
static obs_source_t *raster_input_new(uint32_t pw,uint32_t ph,const uint8_t marker[18]){
 char json[200];snprintf(json,sizeof(json),"{\"width\":%u,\"height\":%u,\"visibleWidth\":%u}",pw<6?6:pw,ph+1,pw);
 obs_data_t *settings=obs_data_create_from_json(json);obs_source_t *source=obs_source_create_private("producer_raster_probe_input","Owned-copy input",settings);obs_data_release(settings);
 require(source&&obs_obj_get_data(source),"raster input created");raster_input_set_marker(source,marker);return source;
}
static void require_expired(obs_weak_source_t *weak,const char *message){obs_source_t *source=obs_weak_source_get_source(weak);if(source)obs_source_release(source);require(!source,message);}
static struct producer_set_v2_raster_creation_stats raster_creation_receipt(obs_source_t *source){
 struct producer_set_v2_raster_creation_stats stats={0},zero={0},consumed;
 require(sizeof(stats)==64&&producer_set_v2_raster_take_creation_stats(source,&stats),"successful raster construction has one bounded timing receipt");
 require(stats.elapsed_ns>0&&stats.effect_compiled<=1,"creation receipt has bounded structural values");
 const uint64_t offsets[]={stats.graphics_wait_offset_ns,stats.effect_compile_offset_ns,stats.texrender_create_offset_ns};
 const uint64_t durations[]={stats.graphics_wait_ns,stats.effect_compile_ns,stats.texrender_create_ns};
 for(int i=0;i<3;i++)require(offsets[i]<=stats.elapsed_ns&&durations[i]<=stats.elapsed_ns-offsets[i],"construction components fit within the C constructor");
 if(!stats.effect_compiled)require(!stats.effect_compile_ns&&!stats.effect_compile_offset_ns,"shader reuse does not invent compile work");
 memset(&consumed,99,sizeof(consumed));require(!producer_set_v2_raster_take_creation_stats(source,&consumed)&&!memcmp(&consumed,&zero,sizeof(zero)),"timing receipt consumes once and clears repeated output");
 return stats;
}
static NSString *raster_case=@"unspecified";
static unsigned raster_delta(NSData *actual,NSData *reference){
 require(actual.length==reference.length,"raster reference dimensions");unsigned delta=0;size_t worst=0;const uint8_t *a=actual.bytes,*b=reference.bytes;
 for(size_t i=0;i<actual.length;i++){unsigned d=abs((int)a[i]-(int)b[i]);if(d>delta){delta=d;worst=i;}}
 if(delta>3){size_t p=(worst/4)*4;fprintf(stderr,"RASTER case=%s maxDelta=%u pixelIndex=%zu actualRGBA=[%u,%u,%u,%u] referenceRGBA=[%u,%u,%u,%u]\n",raster_case.UTF8String,delta,p/4,a[p],a[p+1],a[p+2],a[p+3],b[p],b[p+1],b[p+2],b[p+3]);}
 require(delta<=3,"owned raster equals original crop RGBA within unchanged three-value tolerance");return delta;
}
static obs_source_t *raster_old_crop(obs_source_t *input,uint32_t w,uint32_t h,float density){
 uint32_t pw=(uint32_t)ceilf(w*density),ph=(uint32_t)ceilf(h*density);
 obs_source_t *clip=producer_set_v2_group_create(w,h,0,1);require(clip&&producer_set_v2_group_density(clip,density),"original browser crop allocation");
 require(producer_set_v2_group_add(clip,input,0,0,(pw<6?6.f:pw)*w/pw,(ph+1.f)*h/ph,false)&&producer_set_v2_group_seal(clip),"original crop preserves physical pixels and hides padded receipt");return clip;
}
static NSData *raster_placed_frame(obs_source_t *source,uint32_t w,uint32_t h,float scale,float angle){
 float dw=w*scale,dh=h*scale;uint32_t cw=(uint32_t)ceilf(dw)+40,ch=(uint32_t)ceilf(dh)+40;
 obs_source_t *placed=producer_set_v2_group_create(cw,ch,0,1);require(placed&&add(placed,source,20,20,dw,dh)&&producer_set_v2_group_seal(placed),"raster presentation placement");
 obs_enter_graphics();require(producer_set_v2_group_layer_transform(placed,0,angle,1,1),"raster scaled/rotated placement");obs_leave_graphics();
 NSData *frame=identity_fresh_frame(placed,cw,ch);obs_source_release(placed);return frame;
}
struct raster_context_attempt {obs_source_t *snapshot,*input;bool accepted;};
static void raster_wrong_thread(void *data){struct raster_context_attempt *a=data;a->accepted=producer_set_v2_raster_capture(a->snapshot,a->input);}
static NSDictionary *raster_proof(NSString *out){
 (void)out;register_raster_input();NSMutableArray *checks=[NSMutableArray array];
 require(producer_set_v2_raster_probe_creation_stats_bounds(),"construction offsets include outer-wrapper cost and reject overflow");
 require(!capture_blend_sentinel&&!capture_matrix_sentinel&&!capture_group_count,"raster proof starts with clean capture observers");
 capture_blend_sentinel=solid(8,8,1,0,0,false);capture_matrix_sentinel=solid(8,8,0,1,0,false);
 require(!producer_set_v2_raster_create(0,10,1)&&!producer_set_v2_raster_create(10,0,1)&&!producer_set_v2_raster_create(10,10,NAN)&&!producer_set_v2_raster_create(10,10,.5)&&!producer_set_v2_raster_create(8192,8192,1),"raster validates logical/density/physical budgets");
 uint8_t invalid[18];memset(invalid,99,18);require(!producer_set_v2_raster_get_marker(NULL,invalid),"invalid raster receipt rejected");for(int i=0;i<18;i++)require(!invalid[i],"invalid receipt resets output");
 struct producer_set_v2_raster_creation_stats invalidStats,zeroStats={0};memset(&invalidStats,99,sizeof(invalidStats));require(!producer_set_v2_raster_take_creation_stats(NULL,&invalidStats)&&!memcmp(&invalidStats,&zeroStats,sizeof(zeroStats)),"invalid construction timing resets output");
 const float densities[]={1,1.5,2};
 for(int orientation=0;orientation<2;orientation++)for(int di=0;di<3;di++){
  uint32_t w=orientation?73:117,h=orientation?117:73;float density=densities[di];
  uint32_t pw=(uint32_t)ceilf(w*density),ph=(uint32_t)ceilf(h*density);uint8_t marker[18];
  obs_source_t *snapshot=producer_set_v2_raster_create(w,h,density);require(snapshot&&producer_set_v2_raster_get_marker(snapshot,marker),"new snapshot owns fresh input receipt");
  require(obs_source_get_width(snapshot)==w&&obs_source_get_height(snapshot)==h&&!producer_set_v2_raster_ready(snapshot)&&!producer_set_v2_raster_texture_bytes(snapshot),"unpainted snapshot has known dimensions and no resident pixels");
  struct producer_set_v2_raster_creation_stats construction=raster_creation_receipt(snapshot);
  [checks addObject:@{@"orientation":@(orientation),@"density":@(density),@"constructionNs":@(construction.elapsed_ns),@"graphicsWaitNs":@(construction.graphics_wait_ns),@"effectCompiled":@(construction.effect_compiled),@"effectCompileNs":@(construction.effect_compile_ns),@"texrenderCreateNs":@(construction.texrender_create_ns)}];
  obs_source_t *input=raster_input_new(pw,ph,marker),*clip=raster_old_crop(input,w,h,density);obs_weak_source_t *weak=obs_source_get_weak_source(input);
  require(!producer_set_v2_raster_capture(NULL,input)&&!producer_set_v2_raster_capture(snapshot,NULL)&&!producer_set_v2_raster_capture(snapshot,snapshot),"invalid raster copy sources rejected");
  obs_enter_graphics();require(!producer_set_v2_raster_capture(snapshot,input),"owner copy rejects a held graphics context");obs_leave_graphics();
  struct raster_context_attempt attempt={snapshot,input,true};obs_queue_task(1,raster_wrong_thread,&attempt,true);require(!attempt.accepted,"copy rejects graphics-thread caller");
  require(producer_set_v2_raster_capture(snapshot,input)&&producer_set_v2_raster_ready(snapshot),"fresh input pixels and current GPU fence establish immutable ready snapshot");
  require(producer_set_v2_raster_texture_bytes(snapshot)==(size_t)(pw<12?12:pw)*(ph+1)*4,"owned payload includes all hidden receipt/padding pixels");
  require(!producer_set_v2_raster_capture(snapshot,input),"ready snapshot rejects rewrites");
  NSData *baseline=nil;
  for(int linear=0;linear<2;linear++)for(int framebuffer=0;framebuffer<2;framebuffer++){
   raster_case=[NSString stringWithFormat:@"direct orientation=%d density=%g linear=%d framebuffer=%d",orientation,density,linear,framebuffer];
   capture_linear=linear;capture_framebuffer=framebuffer;NSData *reference=identity_fresh_frame(clip,w,h),*actual=identity_fresh_frame(snapshot,w,h);unsigned delta=raster_delta(actual,reference);if(!linear&&!framebuffer)baseline=reference;
   if(!linear&&!framebuffer){color(reference,w+40,w/2,h/2,136,96,46,255,"old crop contains authored midtone");color(reference,w+40,w/8,h/8,0,0,0,0,"old crop contains authored transparency");color(reference,w+40,w*4/5,h/2,26,51,77,128,"old crop contains premultiplied alpha region");}
   [checks addObject:@{@"orientation":@(orientation),@"density":@(density),@"linear":@(linear),@"framebuffer":@(framebuffer),@"maxDelta":@(delta)}];
  }
  for(int hdr=0;hdr<2;hdr++){
   raster_case=[NSString stringWithFormat:@"HDR orientation=%d density=%g space=%d",orientation,density,hdr?GS_CS_709_SCRGB:GS_CS_SRGB_16F];
   capture_linear=true;capture_framebuffer=1;capture_space=hdr?GS_CS_709_SCRGB:GS_CS_SRGB_16F;
   NSData *reference=identity_fresh_frame(clip,w,h),*actual=identity_fresh_frame(snapshot,w,h);
   if(![actual isEqualToData:reference])fprintf(stderr,"RASTER case=%s exact-byte mismatch\n",raster_case.UTF8String);
   require([actual isEqualToData:reference],"16F/HDR raster matches original crop without tolerance relaxation");
   [checks addObject:@{@"orientation":@(orientation),@"density":@(density),@"colorSpace":@(capture_space),@"exactBytes":@YES}];
  }
  capture_space=GS_CS_SRGB;
  capture_linear=false;capture_framebuffer=0;
  const float scales[]={.6,1.23,1.75,1.4};const float angles[]={0,0,0,13};NSMutableArray *placedReferences=[NSMutableArray array];
  for(int i=0;i<4;i++)[placedReferences addObject:raster_placed_frame(clip,w,h,scales[i],angles[i])];
  obs_source_release(clip);obs_source_release(input);obs_wait_for_destroy_queue();require_expired(weak,"actual input source expires before future snapshot rendering");obs_weak_source_release(weak);
  for(int frame=0;frame<24;frame++){raster_case=[NSString stringWithFormat:@"post-input-drop orientation=%d density=%g frame=%d",orientation,density,frame];raster_delta(identity_fresh_frame(snapshot,w,h),baseline);}
  for(int i=0;i<4;i++){raster_case=[NSString stringWithFormat:@"placement orientation=%d density=%g scale=%g angle=%g",orientation,density,scales[i],angles[i]];raster_delta(raster_placed_frame(snapshot,w,h,scales[i],angles[i]),placedReferences[i]);}
  obs_source_release(snapshot);obs_wait_for_destroy_queue();
 }
 // Narrow authored pixels must not expand to the padded browser width, nor
 // sample the differently colored input/completion fences during upscaling.
 for(int tiny=0;tiny<2;tiny++){
  uint32_t w=tiny?10:1,h=17;float density=tiny?1.1f:1.5f;uint32_t pw=(uint32_t)ceilf(w*density),ph=(uint32_t)ceilf(h*density);uint8_t marker[18];
  obs_source_t *snapshot=producer_set_v2_raster_create(w,h,density);require(snapshot&&producer_set_v2_raster_get_marker(snapshot,marker),"fractional/tiny snapshot");obs_source_t *input=raster_input_new(pw,ph,marker),*clip=raster_old_crop(input,w,h,density);
  require(producer_set_v2_raster_capture(snapshot,input),"fractional f32 physical dimensions agree");
  for(int angle=0;angle<2;angle++){raster_case=[NSString stringWithFormat:@"tiny width=%u density=%g scale=3.5 angle=%d",w,density,angle?13:0];raster_delta(raster_placed_frame(snapshot,w,h,3.5,angle?13:0),raster_placed_frame(clip,w,h,3.5,angle?13:0));}
  obs_source_release(clip);obs_source_release(input);obs_source_release(snapshot);obs_wait_for_destroy_queue();
 }
 // A previous painter's valid receipt must not authorize a different snapshot.
 uint8_t oldMarker[18],freshMarker[18];obs_source_t *old=producer_set_v2_raster_create(40,30,1),*fresh=producer_set_v2_raster_create(40,30,1);require(old&&fresh&&producer_set_v2_raster_get_marker(old,oldMarker)&&producer_set_v2_raster_get_marker(fresh,freshMarker)&&memcmp(oldMarker,freshMarker,18),"fresh snapshots have distinct input receipts");
 struct producer_set_v2_raster_creation_stats reused=raster_creation_receipt(fresh);require(!reused.effect_compiled,"second live raster reports shared shader reuse");
 obs_source_t *stale=raster_input_new(40,30,oldMarker);require(!producer_set_v2_raster_capture(fresh,stale)&&!producer_set_v2_raster_ready(fresh)&&!producer_set_v2_raster_copy_blocked(),"current private completion cannot authorize stale input receipt");
 raster_input_set_marker(stale,freshMarker);
 producer_set_v2_raster_probe_fail_next(2);require(!producer_set_v2_raster_capture(fresh,stale)&&!producer_set_v2_raster_ready(fresh)&&!producer_set_v2_raster_copy_blocked(),"input-render no-op plus successful private GPU draw never becomes ready");
 producer_set_v2_raster_probe_fail_next(1);require(!producer_set_v2_raster_capture(fresh,stale)&&!producer_set_v2_raster_ready(fresh)&&!producer_set_v2_raster_copy_blocked(),"pre-read staging allocation failure is safely retryable");
 require(producer_set_v2_raster_capture(fresh,stale),"completed retry with correct input receipt succeeds");obs_source_release(stale);obs_source_release(old);obs_source_release(fresh);obs_wait_for_destroy_queue();
 // Unknown GPU completion is terminal in product. The probe-only recovery
 // first obtains a NEW real readback receipt, then releases all retained state.
 for(int fault=3;fault<=4;fault++){
  uint8_t marker[18];obs_source_t *snapshot=producer_set_v2_raster_create(40,30,1);require(snapshot&&producer_set_v2_raster_get_marker(snapshot,marker),"failure-case snapshot");obs_source_t *input=raster_input_new(40,30,marker);obs_weak_source_t *inputWeak=obs_source_get_weak_source(input),*snapshotWeak=obs_source_get_weak_source(snapshot);
  producer_set_v2_raster_probe_fail_next(fault);require(!producer_set_v2_raster_capture(snapshot,input)&&!producer_set_v2_raster_ready(snapshot)&&producer_set_v2_raster_copy_blocked()&&producer_set_v2_raster_quarantine_count()==1,"failed copy/map evidence never publishes and enters one bounded quarantine");
  require(obs_source_active(input)&&obs_source_showing(input),"C quarantine preserves independent active/showing leases");
  require(!producer_set_v2_raster_capture(snapshot,input)&&producer_set_v2_raster_quarantine_count()==1,"quarantine blocks later work without accumulating leases");
  obs_source_release(input);obs_source_release(snapshot);obs_wait_for_destroy_queue();
  obs_source_t *held=obs_weak_source_get_source(inputWeak);require(held!=NULL,"quarantine retains actual input after all caller references drop");obs_source_release(held);
  require(producer_set_v2_raster_probe_recover_quarantine()&&!producer_set_v2_raster_copy_blocked()&&!producer_set_v2_raster_quarantine_count(),"probe cleanup releases only after new actual GPU completion proof");obs_wait_for_destroy_queue();require_expired(inputWeak,"input expires after proven cleanup");require_expired(snapshotWeak,"snapshot expires after proven cleanup");obs_weak_source_release(inputWeak);obs_weak_source_release(snapshotWeak);
 }
 capture_linear=false;capture_framebuffer=-1;capture_space=GS_CS_SRGB;capture_transform=false;
 obs_source_t *blend=capture_blend_sentinel,*matrix=capture_matrix_sentinel;capture_blend_sentinel=capture_matrix_sentinel=NULL;obs_source_release(blend);obs_source_release(matrix);obs_wait_for_destroy_queue();
 require(!atomic_load(&raster_inputs_live)&&!producer_set_v2_live_groups(),"all raster fixture inputs/groups released");
 return @{@"scope":@"pure GPU immutable copies, unique input/completion receipts, actual source expiry, visible-edge clamp, density/alpha/colors and terminal failure ownership",@"checks":checks,@"postInputDestructionFramesPerSnapshot":@24,@"stageNoopAndMapFailureVerified":@YES,@"remainingInputs":@(atomic_load(&raster_inputs_live))};
}
#endif
