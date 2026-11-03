#include "../src-tauri/src/live/soundboard.c"
#include <assert.h>
#include <stdio.h>
#include <unistd.h>
#import <AppKit/AppKit.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdatomic.h>
OBS_IMPORT bool obs_startup(const char*,const char*,void*);
struct video_info{const char*graphics_module;uint32_t fps_num,fps_den,base_width,base_height,output_width,output_height;int format;uint32_t adapter;bool gpu;int colorspace,range,scale;};
struct audio_info{uint32_t rate;int speakers;};
OBS_IMPORT int obs_reset_video(struct video_info*);
OBS_IMPORT bool obs_reset_audio(struct audio_info*);
OBS_IMPORT void *obs_get_audio(void);
OBS_IMPORT obs_source_t *obs_source_create(const char*,const char*,obs_data_t*,obs_data_t*);
OBS_IMPORT void obs_set_output_source(uint32_t,obs_source_t*);
OBS_IMPORT void obs_source_set_audio_mixers(obs_source_t*,uint32_t);
OBS_IMPORT void obs_source_set_monitoring_type(obs_source_t*,int);
OBS_IMPORT void obs_source_release(obs_source_t*);
struct audio_data{uint8_t*data[8];uint32_t frames;uint64_t timestamp;};
struct convert{uint32_t rate;int format,speakers;bool clipping;};
OBS_IMPORT bool audio_output_connect(void*,size_t,const struct convert*,void(*)(void*,size_t,struct audio_data*),void*);
static pthread_mutex_t results=PTHREAD_MUTEX_INITIALIZER;static double power[2];static size_t counts[2];
static void capture(void*p,size_t bus,struct audio_data*d){(void)p;if(bus>1)return;pthread_mutex_lock(&results);for(size_t c=0;c<2;c++)for(size_t i=0;i<d->frames;i++){float v=((float*)d->data[c])[i];power[bus]+=v*v;counts[bus]++;}pthread_mutex_unlock(&results);}
static void measure(double out[2]){usleep(200000);pthread_mutex_lock(&results);memset(power,0,sizeof(power));memset(counts,0,sizeof(counts));pthread_mutex_unlock(&results);usleep(500000);pthread_mutex_lock(&results);for(int i=0;i<2;i++)out[i]=sqrt(power[i]/(counts[i]?counts[i]:1));pthread_mutex_unlock(&results);}
int test_main(int argc,char**argv){assert(argc==2);assert(obs_startup("en-US",NULL,NULL));struct video_info v={argv[1],30,1,640,360,640,360,2,0,true,2,1,3};assert(obs_reset_video(&v)==0);struct audio_info a={48000,2};assert(obs_reset_audio(&a));producer_soundboard_register();obs_source_t*s=obs_source_create("producer_soundboard","Soundboard test",NULL,NULL);assert(s);obs_source_set_audio_mixers(s,3);obs_source_set_monitoring_type(s,0);obs_set_output_source(5,s);float *pcm=malloc(48000*2*4);for(size_t i=0;i<48000;i++)pcm[i*2]=pcm[i*2+1]=sinf(i*6.2831853f*440/48000)*.2f;assert(producer_soundboard_load(s,1,pcm,48000));free(pcm);struct convert c={48000,8,2,false};assert(audio_output_connect(obs_get_audio(),0,&c,capture,NULL));assert(audio_output_connect(obs_get_audio(),1,&c,capture,NULL));assert(producer_soundboard_trigger(s,1,3,1,0));double live[2],stopped[2],preview[2];measure(live);producer_soundboard_stop(s);measure(stopped);obs_source_set_monitoring_type(s,1);producer_soundboard_trigger(s,1,3,1,0);measure(preview);producer_soundboard_stop(s);obs_set_output_source(5,NULL);obs_source_release(s);printf("Live: %.6f %.6f; stopped: %.6f %.6f; preview leakage: %.6f %.6f\n",live[0],live[1],stopped[0],stopped[1],preview[0],preview[1]);fflush(stdout);assert(live[0]>.05&&live[1]>.05);assert(stopped[0]<.001&&stopped[1]<.001);assert(preview[0]<.001&&preview[1]<.001);puts("PASS: actual OBS audio, both buses, stop and private monitoring");return 0;}

static atomic_bool done=false;static char **args;static void*worker(void*x){(void)x;test_main(2,args);atomic_store(&done,true);return NULL;}
int main(int argc,char**argv){assert(argc==2);[NSApplication sharedApplication];args=argv;pthread_t t;pthread_create(&t,NULL,worker,NULL);while(!atomic_load(&done))CFRunLoopRunInMode(kCFRunLoopDefaultMode,.01,true);pthread_join(t,NULL);return 0;}
