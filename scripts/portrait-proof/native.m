/* Isolated macOS/OBS 32.1.2 visual proof, never linked into Producer.
 * ABI subset verified against engine/obs.lock and src-tauri/src/live/ffi.rs.
 * No capture devices, audio sources, recorder or external stream destinations. */
#import <AppKit/AppKit.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <pthread.h>
#include <unistd.h>

typedef void obs_source_t; typedef void obs_data_t; typedef void obs_scene_t;
typedef void obs_sceneitem_t; typedef void obs_module_t;
struct vec2 {float x,y;};
struct obs_video_info {const char *graphics_module; uint32_t fps_num,fps_den,base_width,base_height,output_width,output_height; int output_format; uint32_t adapter; bool gpu_conversion; int colorspace,range,scale_type;};
struct video_scale_info {int format; uint32_t width,height; int range,colorspace;};
struct video_data {uint8_t *data[8];uint32_t linesize[8];uint64_t timestamp;};
extern void producer_source_appearance_register(void);
extern obs_source_t *producer_source_placement_create(obs_source_t *);
extern size_t obs_source_filter_count(const obs_source_t *);
extern uint32_t obs_source_get_output_flags(const obs_source_t *);
extern bool obs_startup(const char *,const char *,void *);
extern bool obs_wait_for_destroy_queue(void);
extern void obs_sceneitem_remove(obs_sceneitem_t *);
extern void obs_shutdown(void), obs_set_cmdline_args(int,const char **), obs_add_data_path(const char *),obs_post_load_modules(void);
extern void obs_set_ui_task_handler(void (*)(void (*)(void *),void *,bool));
extern int obs_reset_video(struct obs_video_info *),obs_open_module(obs_module_t **,const char *,const char *);
extern bool obs_init_module(obs_module_t *);
extern void obs_set_video_levels(float,float);
extern obs_data_t *obs_data_create(void);
extern void obs_data_release(obs_data_t *),obs_data_set_string(obs_data_t *,const char *,const char *),obs_data_set_int(obs_data_t *,const char *,int64_t),obs_data_set_bool(obs_data_t *,const char *,bool);
extern obs_source_t *obs_source_create(const char *,const char *,obs_data_t *,obs_data_t *);
extern void obs_data_set_double(obs_data_t *,const char *,double);
extern obs_source_t *obs_source_create_private(const char *,const char *,obs_data_t *);
extern void obs_source_filter_add(obs_source_t *,obs_source_t *),obs_source_update(obs_source_t *,obs_data_t *);
extern void obs_source_release(obs_source_t *),obs_source_set_audio_mixers(obs_source_t *,uint32_t);
extern obs_scene_t *obs_scene_create(const char *);
extern void obs_scene_release(obs_scene_t *);
extern obs_source_t *obs_scene_get_source(obs_scene_t *);
extern obs_sceneitem_t *obs_scene_add(obs_scene_t *,obs_source_t *);
extern void obs_set_output_source(uint32_t,obs_source_t *),obs_sceneitem_set_pos(obs_sceneitem_t *,const struct vec2 *),obs_sceneitem_get_pos(obs_sceneitem_t *,struct vec2 *),obs_sceneitem_set_bounds(obs_sceneitem_t *,const struct vec2 *),obs_sceneitem_get_bounds(obs_sceneitem_t *,struct vec2 *),obs_sceneitem_set_bounds_type(obs_sceneitem_t *,int);
extern bool obs_sceneitem_set_visible(obs_sceneitem_t *,bool);
extern void obs_add_raw_video_callback(const struct video_scale_info *,void (*)(void *,struct video_data *),void *),obs_remove_raw_video_callback(void (*)(void *,struct video_data *),void *);

static atomic_bool finished=false;
static atomic_int exitCode=1,capture=0;
static NSString *outputDir;
static void uiTask(void (*task)(void *),void *param,bool wait) {
  if([NSThread isMainThread]){task(param);return;}
  if(wait)dispatch_sync(dispatch_get_main_queue(),^{task(param);});
  else dispatch_async(dispatch_get_main_queue(),^{task(param);});
}
static void frame(void *param,struct video_data *f) {
  int stage=atomic_exchange(&capture,0);if(!stage)return;
  char path[4096];snprintf(path,sizeof(path),"%s/frame-%d.bgra",outputDir.UTF8String,stage);
  FILE *file=fopen(path,"wb");if(!file)return;
  for(int y=0;y<720;y++)fwrite(f->data[0]+y*f->linesize[0],1,1280*4,file);
  fclose(file);
  printf("CAPTURE %d %llu\n",stage,(unsigned long long)f->timestamp);fflush(stdout);
}
static obs_source_t *source(const char *id,const char *name,const char *url,uint32_t color) {
  obs_data_t *d=obs_data_create();
  obs_data_set_int(d,"width",(url||strcmp(name,"Set backdrop")==0)?1280:320);obs_data_set_int(d,"height",(url||strcmp(name,"Set backdrop")==0)?720:180);
  if(url){obs_data_set_string(d,"url",url);obs_data_set_int(d,"webpage_control_level",0);obs_data_set_int(d,"fps",30);obs_data_set_bool(d,"fps_custom",true);obs_data_set_bool(d,"shutdown",false);obs_data_set_bool(d,"restart_when_active",false);obs_data_set_bool(d,"reroute_audio",true);}
  else obs_data_set_int(d,"color",color);
  obs_source_t *s=obs_source_create(id,name,d,NULL);obs_data_release(d);
  if(s)obs_source_set_audio_mixers(s,0);return s;
}
typedef void obs_canvas_t; typedef void video_t; typedef void audio_t; typedef void obs_encoder_t; typedef void obs_output_t;
struct obs_audio_info {uint32_t samples_per_sec;int speakers;};
extern bool obs_reset_audio(const struct obs_audio_info *);
extern audio_t *obs_get_audio(void);
extern video_t *obs_get_video(void);
extern obs_canvas_t *obs_canvas_create_private(const char *,struct obs_video_info *,uint32_t);
extern obs_scene_t *obs_canvas_scene_create(obs_canvas_t *,const char *);
extern void obs_canvas_set_channel(obs_canvas_t *,uint32_t,obs_source_t *);
extern video_t *obs_canvas_get_video(const obs_canvas_t *);
extern void obs_canvas_remove(obs_canvas_t *),obs_canvas_release(obs_canvas_t *);
extern bool obs_get_video_info(struct obs_video_info *);
extern bool video_output_connect(video_t *,const struct video_scale_info *,void (*)(void *,struct video_data *),void *);
extern void video_output_disconnect(video_t *,void (*)(void *,struct video_data *),void *);
extern obs_encoder_t *obs_video_encoder_create(const char *,const char *,obs_data_t *,void *);
extern obs_encoder_t *obs_audio_encoder_create(const char *,const char *,obs_data_t *,size_t,void *);
extern void obs_encoder_set_video(obs_encoder_t *,video_t *),obs_encoder_set_audio(obs_encoder_t *,audio_t *),obs_encoder_release(obs_encoder_t *);
extern obs_output_t *obs_output_create(const char *,const char *,obs_data_t *,void *);
extern void obs_output_set_video_encoder(obs_output_t *,obs_encoder_t *),obs_output_set_audio_encoder(obs_output_t *,obs_encoder_t *,size_t);
extern bool obs_output_start(obs_output_t *),obs_output_active(obs_output_t *);
extern void obs_output_stop(obs_output_t *),obs_output_release(obs_output_t *);
struct Capture {int width,height; const char *name; atomic_int frames;atomic_bool save;};
static void canvasFrame(void *param,struct video_data *v){struct Capture *c=param;atomic_fetch_add(&c->frames,1);if(!atomic_exchange(&c->save,false))return;char file[4096];snprintf(file,sizeof(file),"%s/%s.bgra",outputDir.UTF8String,c->name);FILE *f=fopen(file,"wb");if(!f)return;for(int y=0;y<c->height;y++)fwrite(v->data[0]+y*v->linesize[0],1,c->width*4,f);fclose(f);}
struct Recording {obs_output_t *out;obs_encoder_t *video,*audio;};
static struct Recording record(const char *name,video_t *video){
 struct Recording r={0};obs_data_t *d=obs_data_create();obs_data_set_string(d,"rate_control","CBR");obs_data_set_int(d,"bitrate",2500);obs_data_set_int(d,"keyint_sec",2);
 r.video=obs_video_encoder_create("com.apple.videotoolbox.videoencoder.ave.avc",name,d,NULL);obs_data_release(d);
 d=obs_data_create();obs_data_set_int(d,"bitrate",192);r.audio=obs_audio_encoder_create("CoreAudio_AAC",name,d,0,NULL);obs_data_release(d);
 if(!r.video||!r.audio){fprintf(stderr,"encoder allocation failed\n");return r;}
 obs_encoder_set_video(r.video,video);obs_encoder_set_audio(r.audio,obs_get_audio());d=obs_data_create();NSString *path=[outputDir stringByAppendingPathComponent:[[NSString stringWithUTF8String:name] stringByAppendingString:@".mp4"]];obs_data_set_string(d,"path",path.UTF8String);
 r.out=obs_output_create("ffmpeg_muxer",name,d,NULL);obs_data_release(d);if(!r.out)return r;obs_output_set_video_encoder(r.out,r.video);obs_output_set_audio_encoder(r.out,r.audio,0);if(!obs_output_start(r.out)){fprintf(stderr,"record start failed\n");obs_output_release(r.out);r.out=NULL;}return r;
}
static void stopRecording(struct Recording r){if(r.out){obs_output_stop(r.out);for(int i=0;i<100&&obs_output_active(r.out);i++)usleep(50000);obs_output_release(r.out);}if(r.video)obs_encoder_release(r.video);if(r.audio)obs_encoder_release(r.audio);}
static obs_source_t *browser(const char *name,const char *url,int width,int height){obs_data_t *d=obs_data_create();obs_data_set_string(d,"url",url);obs_data_set_int(d,"width",width);obs_data_set_int(d,"height",height);obs_data_set_int(d,"fps",30);obs_data_set_bool(d,"fps_custom",true);obs_data_set_bool(d,"shutdown",false);obs_data_set_bool(d,"reroute_audio",true);obs_data_set_int(d,"webpage_control_level",0);obs_source_t *s=obs_source_create("browser_source",name,d,NULL);obs_data_release(d);if(s)obs_source_set_audio_mixers(s,0);return s;}
static void engine(const char *landURL,const char *portraitURL,const char *debug){
 @autoreleasepool {
 struct obs_video_info v={"/Applications/Producer.app/Contents/Frameworks/libobs-metal.dylib",30,1,1280,720,1280,720,2,0,true,2,1,3};
 if(obs_reset_video(&v))return;struct obs_audio_info ai={48000,2};if(!obs_reset_audio(&ai))return;
 for(NSString *plugin in @[@"image-source",@"obs-browser",@"obs-ffmpeg",@"mac-videotoolbox",@"coreaudio-encoder"]){NSString *base=[@"/Applications/Producer.app/Contents/PlugIns" stringByAppendingPathComponent:[plugin stringByAppendingString:@".plugin/Contents"]];obs_module_t *m=NULL;if(obs_open_module(&m,[[base stringByAppendingPathComponent:[@"MacOS/" stringByAppendingString:plugin]] UTF8String],[[base stringByAppendingPathComponent:@"Resources"] UTF8String])||!obs_init_module(m))return;}
 obs_post_load_modules();producer_source_appearance_register();
 obs_source_t *shared=source("color_source_v3","Shared capture",NULL,0xff60c020);if(!shared)return;
 obs_scene_t *land=obs_scene_create("Landscape proof");obs_set_output_source(0,obs_scene_get_source(land));
 obs_sceneitem_t *li=obs_scene_add(land,shared);struct vec2 lp={80,160},lb={720,440};obs_sceneitem_set_pos(li,&lp);obs_sceneitem_set_bounds_type(li,1);obs_sceneitem_set_bounds(li,&lb);
 obs_source_t *lg=browser("Landscape graphics",landURL,1280,720);if(!lg)return;obs_sceneitem_t *lgi=obs_scene_add(land,lg);
 obs_data_t *ad=obs_data_create();NSString *tone=[outputDir stringByAppendingPathComponent:@"tone.wav"];obs_data_set_string(ad,"local_file",tone.UTF8String);obs_data_set_bool(ad,"is_local_file",true);obs_data_set_bool(ad,"looping",true);obs_source_t *audio=obs_source_create("ffmpeg_source","One test tone",ad,NULL);obs_data_release(ad);if(!audio)return;obs_source_set_audio_mixers(audio,1);obs_sceneitem_t *lai=obs_scene_add(land,audio);
 struct obs_video_info portrait=v;portrait.base_width=720;portrait.base_height=1280;portrait.output_width=720;portrait.output_height=1280;
 // ACTIVATE|SCENE_REF|EPHEMERAL: deliberately omit MIX_AUDIO.
 obs_canvas_t *canvas=obs_canvas_create_private("Portrait proof",&portrait,2|8|16);if(!canvas)return;obs_scene_t *ps=obs_canvas_scene_create(canvas,"Portrait scene");if(!ps)return;obs_canvas_set_channel(canvas,0,obs_scene_get_source(ps));
 obs_sceneitem_t *pi=obs_scene_add(ps,shared);struct vec2 pp={60,250},pb={600,620};obs_sceneitem_set_pos(pi,&pp);obs_sceneitem_set_bounds_type(pi,1);obs_sceneitem_set_bounds(pi,&pb);
 obs_source_t *pg=browser("Portrait graphics",portraitURL,720,1280);if(!pg)return;obs_sceneitem_t *pgi=obs_scene_add(ps,pg),*pai=obs_scene_add(ps,audio);
 struct Capture lc={1280,720,"landscape",0,true},pc={720,1280,"portrait",0,true};struct video_scale_info ls={7,1280,720,2,2},pcs={7,720,1280,2,2};
 video_t *pv=obs_canvas_get_video(canvas);if(!pv||!video_output_connect(obs_get_video(),&ls,canvasFrame,&lc)||!video_output_connect(pv,&pcs,canvasFrame,&pc))return;
 usleep(2500000);atomic_store(&lc.save,true);atomic_store(&pc.save,true);
 struct Recording lr=record("landscape",obs_get_video()),pr=record("portrait",pv);if(!lr.out||!pr.out)return;
 int seconds=15;const char *duration=getenv("PRODUCER_PORTRAIT_PROOF_SECONDS");if(duration)seconds=MAX(3,atoi(duration));sleep(seconds);
 stopRecording(pr);video_output_disconnect(pv,canvasFrame,&pc);obs_canvas_set_channel(canvas,0,NULL);obs_sceneitem_remove(pi);obs_sceneitem_remove(pgi);obs_sceneitem_remove(pai);obs_scene_release(ps);obs_canvas_remove(canvas);obs_canvas_release(canvas);obs_source_release(pg);
 int before=atomic_load(&lc.frames);
 for(int i=0;i<100;i++){obs_canvas_t *c=obs_canvas_create_private("Lifecycle proof",&portrait,2|8|16);if(!c)return;obs_scene_t *s=obs_canvas_scene_create(c,"Cycle");if(!s)return;obs_scene_add(s,shared);obs_canvas_set_channel(c,0,obs_scene_get_source(s));usleep(10000);obs_canvas_set_channel(c,0,NULL);obs_scene_release(s);obs_canvas_remove(c);obs_canvas_release(c);}
 sleep(1);int continued=atomic_load(&lc.frames)-before;stopRecording(lr);
 struct obs_video_info unchanged={0};obs_get_video_info(&unchanged);
 NSDictionary *result=@{@"ok":@(continued>0&&unchanged.base_width==1280&&unchanged.base_height==720),@"landscapeFrames":@(atomic_load(&lc.frames)),@"portraitFrames":@(atomic_load(&pc.frames)),@"primaryFramesAfterPortraitStopped":@(continued),@"cleanupCycles":@100,@"sharedVideoSource":@YES,@"secondaryMixesAudio":@NO,@"seconds":@(seconds)};
 NSData *json=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil];[json writeToFile:[outputDir stringByAppendingPathComponent:@"result.json"] atomically:YES];
 fprintf(stderr,"CLEANUP disconnect\n");video_output_disconnect(obs_get_video(),canvasFrame,&lc);fprintf(stderr,"CLEANUP channel\n");obs_set_output_source(0,NULL);fprintf(stderr,"CLEANUP scene\n");obs_sceneitem_remove(li);obs_sceneitem_remove(lgi);obs_sceneitem_remove(lai);obs_scene_release(land);obs_source_release(lg);obs_source_release(audio);obs_source_release(shared);fprintf(stderr,"CLEANUP queue\n");obs_wait_for_destroy_queue();fprintf(stderr,"CLEANUP queue drained\n");
 // CEF closure is asynchronous; let the main-thread pump complete before shutdown.
 printf("NATIVE_GRAPH_RELEASED\n");fflush(stdout);bool closed=false;for(int tick=0;tick<300;tick++){usleep(100000);if([[NSFileManager defaultManager] fileExistsAtPath:[outputDir stringByAppendingPathComponent:@"cef-closed"]]){closed=true;break;}}if(!closed){fprintf(stderr,"CEF closure not acknowledged\n");return;}obs_shutdown();atomic_store(&exitCode,continued>0?0:1);
 }
}
int main(int argc,char **argv) {
 if(argc!=5)return 2;
 @autoreleasepool {
  [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  outputDir=[[NSString alloc] initWithUTF8String:argv[3]];
  const char *args[]={"producer",argv[4]};obs_set_cmdline_args(2,args);
  NSString *config=[outputDir stringByAppendingPathComponent:@"obs-config"];
  [[NSFileManager defaultManager] createDirectoryAtPath:config withIntermediateDirectories:YES attributes:nil error:nil];
  obs_add_data_path("/Applications/Producer.app/Contents/Frameworks/libobs.framework/Resources/");
  if(!obs_startup("en-US",config.UTF8String,NULL)){fprintf(stderr,"startup failed\n");return 1;}
  obs_set_ui_task_handler(uiTask);
  [NSApp finishLaunching];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{engine(argv[1],argv[2],argv[4]);atomic_store(&finished,true);dispatch_async(dispatch_get_main_queue(),^{[NSApp stop:nil];[NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:NO];});});
  [NSApp run];
  return atomic_load(&exitCode);
 }
}
