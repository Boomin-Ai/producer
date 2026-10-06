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
static void engine(const char *bg,const char *fg,const char *debug) {
 @autoreleasepool {
  (void)debug;bool patterns=strncmp(bg,"pattern",7)==0,shared=strcmp(bg,"pattern-shared")==0;
  struct obs_video_info v={"/Applications/Producer.app/Contents/Frameworks/libobs-opengl.dylib",30,1,1280,720,1280,720,7,0,false,2,2,3};
  const char *metal=getenv("PRODUCER_PROOF_METAL");
  if(!metal || strcmp(metal,"0")!=0){v.graphics_module="/Applications/Producer.app/Contents/Frameworks/libobs-metal.dylib";v.output_format=2;v.gpu_conversion=true;v.range=1;}
  int rc=obs_reset_video(&v);if(rc){fprintf(stderr,"video failed %d\n",rc);obs_shutdown();return;}
  obs_set_video_levels(300,1000);producer_source_appearance_register();
  for(NSString *plugin in (patterns?@[@"image-source"]:@[@"image-source",@"obs-browser"])){
    NSString *base=[@"/Applications/Producer.app/Contents/PlugIns" stringByAppendingPathComponent:[plugin stringByAppendingString:@".plugin/Contents"]];
    obs_module_t *module=NULL;
    int open=obs_open_module(&module,[[base stringByAppendingPathComponent:[@"MacOS/" stringByAppendingString:plugin]] UTF8String],[[base stringByAppendingPathComponent:@"Resources"] UTF8String]);
    if(open||!obs_init_module(module)){fprintf(stderr,"plugin failed %s %d\n",plugin.UTF8String,open);obs_shutdown();return;}
  }
  obs_post_load_modules();
  obs_scene_t *scene=obs_scene_create("Isolated presentation proof");
  obs_source_t *captures[2]={source("color_source_v3","Native host pattern",NULL,0xff60c020),source("color_source_v3","Native guest pattern",NULL,0xff3080f0)};
  obs_source_t *sources[4]={source(patterns?"color_source_v3":"browser_source","Set backdrop",patterns?NULL:bg,0xff201018),producer_source_placement_create(captures[0]),producer_source_placement_create(captures[shared?0:1]),source(patterns?"color_source_v3":"browser_source","Set foreground",patterns?NULL:fg,0)};
  for(int i=1;i<=2;i++)if(!sources[i] || (obs_source_get_output_flags(sources[i])&2)){fprintf(stderr,"placement must be video-only\n");return;}
  if(producer_source_placement_create(sources[1])!=NULL){fprintf(stderr,"proxy recursion accepted\n");return;}
  obs_source_t *appearance[2];
  for(int i=0;i<2;i++){appearance[i]=obs_source_create_private("producer_source_appearance","Source appearance",NULL);if(!appearance[i]){fprintf(stderr,"appearance failed\n");return;}obs_source_filter_add(sources[i+1],appearance[i]);}
  obs_sceneitem_t *items[4];
  for(int i=0;i<4;i++){if(!sources[i]){fprintf(stderr,"source %d failed\n",i);return;}items[i]=obs_scene_add(scene,sources[i]);if(i==1||i==2)obs_sceneitem_set_visible(items[i],false);}
  obs_set_output_source(0,obs_scene_get_source(scene));
  struct video_scale_info scale={7,1280,720,2,2};
  obs_add_raw_video_callback(&scale,frame,NULL);
  printf("NATIVE_READY\n");fflush(stdout);
  int lastStage=0;
  for(int tick=0;tick<600;tick++){
    usleep(100000);
    @autoreleasepool {
      NSData *data=[NSData dataWithContentsOfFile:[outputDir stringByAppendingPathComponent:@"command.json"]];
      NSDictionary *cmd=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
      if([cmd[@"stop"] boolValue])break;
      int stage=[cmd[@"stage"] intValue];if(stage<=lastStage)continue;
      NSArray *slots=cmd[@"slots"];if(![slots isKindOfClass:[NSArray class]])continue;
      NSMutableArray *actual=[NSMutableArray array];
      for(int i=1;i<=2;i++){
        NSDictionary *slot=nil;for(NSDictionary *s in slots)if([s[@"slotId"] isEqual:(i==1?@"host":@"guest")])slot=s;
        obs_sceneitem_set_visible(items[i],slot!=nil);if(!slot)continue;
        float x=[slot[@"x"] floatValue],y=[slot[@"y"] floatValue],w=[slot[@"width"] floatValue],h=[slot[@"height"] floatValue];
        if(!isfinite(x)||!isfinite(y)||!isfinite(w)||!isfinite(h)||x<0||y<0||w<=0||h<=0||x+w>1281||y+h>721){fprintf(stderr,"invalid geometry\n");return;}
        NSDictionary *a=slot[@"appearance"];
        obs_data_t *appearanceData=obs_data_create();
        obs_data_set_string(appearanceData,"shape",[a[@"shape"] isEqual:@"circle"]?"circle":"rectangle");
        obs_data_set_string(appearanceData,"outlineColor",[a[@"outlineColor"] isKindOfClass:[NSString class]]?[a[@"outlineColor"] UTF8String]:"#ffffff");
        for(NSString *key in @[@"cornerRadius",@"outlineWidth",@"grayscale",@"opacity"])
            obs_data_set_double(appearanceData,key.UTF8String,a[key]?[a[key] doubleValue]:([key isEqual:@"opacity"]?1:0));
        obs_data_set_double(appearanceData,"displayWidth",w);obs_data_set_double(appearanceData,"displayHeight",h);
        obs_source_update(appearance[i-1],appearanceData);obs_data_release(appearanceData);
        struct vec2 pos={x,y},bounds={w,h},readPos,readBounds;
        obs_sceneitem_set_pos(items[i],&pos);obs_sceneitem_set_bounds_type(items[i],1);obs_sceneitem_set_bounds(items[i],&bounds);
        obs_sceneitem_get_pos(items[i],&readPos);obs_sceneitem_get_bounds(items[i],&readBounds);
        [actual addObject:@{@"slotId":slot[@"slotId"],@"x":@(readPos.x),@"y":@(readPos.y),@"width":@(readBounds.x),@"height":@(readBounds.y)}];
      }
      NSDictionary *receipt=@{@"stage":@(stage),@"revision":cmd[@"revision"]?:@0,@"slots":actual};
      for(int i=0;i<2;i++)if(obs_source_filter_count(captures[i])!=0){fprintf(stderr,"placement mutated capture filters\n");return;}
      NSData *receiptData=[NSJSONSerialization dataWithJSONObject:receipt options:NSJSONWritingPrettyPrinted error:nil];
      [receiptData writeToFile:[outputDir stringByAppendingPathComponent:[NSString stringWithFormat:@"native-%d.json",stage]] atomically:YES];
      // Deliberately wait for stable pixels. This is not a two-frame commit proof.
      usleep(600000);atomic_store(&capture,stage);lastStage=stage;
    }
  }
  obs_remove_raw_video_callback(frame,NULL);obs_set_output_source(0,NULL);
  for(int i=0;i<4;i++)obs_sceneitem_remove(items[i]);
  obs_scene_release(scene);for(int i=0;i<2;i++)obs_source_release(appearance[i]);for(int i=0;i<4;i++)obs_source_release(sources[i]);
  for(int i=0;i<2;i++)obs_source_release(captures[i]);
  obs_wait_for_destroy_queue();
  // BrowserSource destruction schedules CEF closure asynchronously. Draining
  // OBS's source queue alone does not prove those browser hosts have closed.
  // The test driver acknowledges an empty CEF target list before module unload.
  if(!patterns){
    printf("NATIVE_GRAPH_RELEASED\n");fflush(stdout);bool closed=false;
    for(int tick=0;tick<150;tick++){
      usleep(100000);
      @autoreleasepool {
        NSData *data=[NSData dataWithContentsOfFile:[outputDir stringByAppendingPathComponent:@"command.json"]];
        NSDictionary *cmd=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
        if([cmd[@"shutdown"] boolValue]){closed=true;break;}
      }
    }
    if(!closed){fprintf(stderr,"CEF closure was not acknowledged\n");return;}
  }
  obs_shutdown();atomic_store(&exitCode,0);
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
