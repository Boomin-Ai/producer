/* Room-owned 48 kHz PCM effects. OBS pulls the clock; UI/graphics never schedule audio. */
#include "obs_min.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#ifdef _WIN32
#include <windows.h>
typedef SRWLOCK sb_lock;
#define LOCK_INIT(p) InitializeSRWLock(p)
#define LOCK(p) AcquireSRWLockExclusive(p)
#define UNLOCK(p) ReleaseSRWLockExclusive(p)
#define TRYLOCK(p) TryAcquireSRWLockExclusive(p)
#else
#include <pthread.h>
typedef pthread_mutex_t sb_lock;
#define LOCK_INIT(p) pthread_mutex_init(p, NULL)
#define LOCK(p) pthread_mutex_lock(p)
#define UNLOCK(p) pthread_mutex_unlock(p)
#define TRYLOCK(p) (pthread_mutex_trylock(p) == 0)
#endif
#define CLIPS 32
#define VOICES 32
#define LIMIT (64u * 1024u * 1024u)
#define FRAMES 1024
struct clip { uint64_t id, used; float *pcm; size_t frames; };
struct voice { uint64_t id; size_t pos; float gain; unsigned fade, age, stop; bool loop; };
struct board { sb_lock lock; struct clip clips[CLIPS]; struct voice voices[VOICES]; size_t bytes; uint64_t clock, anchor, rendered; float gain; };
struct plane { float *data[8]; };
struct mix { struct plane output[6]; };
OBS_IMPORT void *obs_obj_get_data(void *);
OBS_IMPORT uint64_t os_gettime_ns(void);
static uint64_t ns(uint64_t f) { return f / 48000 * 1000000000ULL + f % 48000 * 1000000000ULL / 48000; }
static struct clip *find(struct board *s, uint64_t id) { for(int i=0;i<CLIPS;i++) if(s->clips[i].id==id) return &s->clips[i]; return NULL; }
static bool active(struct board *s,uint64_t id) { for(int i=0;i<VOICES;i++) if(s->voices[i].id==id) return true; return false; }
static const char *name(void *unused) { (void)unused; return "Producer soundboard"; }
static void *create(obs_data_t *settings,obs_source_t *source) { (void)settings;(void)source;struct board *s=calloc(1,sizeof(*s));if(s){LOCK_INIT(&s->lock);s->gain=1;}return s; }
static void destroy(void *data) { struct board *s=data;if(!s)return;for(int i=0;i<CLIPS;i++)free(s->clips[i].pcm);
#ifndef _WIN32
pthread_mutex_destroy(&s->lock);
#endif
free(s); }
static bool render(void *data,uint64_t *ts,void *out,uint32_t mixers,size_t channels,size_t rate) {
 struct board *s=data;struct mix *m=out;if(!s||rate!=48000||channels>8||!channels)return false;
 uint64_t now=os_gettime_ns();if(!s->anchor||now>s->anchor+ns(s->rendered)+100000000ULL){s->anchor=now;s->rendered=0;}
 *ts=s->anchor+ns(s->rendered);s->rendered+=FRAMES;
 for(int b=0;b<6;b++)if(mixers&(1u<<b))for(size_t c=0;c<channels;c++)if(m->output[b].data[c])memset(m->output[b].data[c],0,FRAMES*sizeof(float));
 /* No allocation or waiting on the audio thread. Control holds this lock only for metadata. */
 if(!TRYLOCK(&s->lock))return true;
 for(int v=0;v<VOICES;v++) { struct voice *a=&s->voices[v];if(!a->id)continue;struct clip *p=find(s,a->id);if(!p){a->id=0;continue;}
  for(size_t f=0;f<FRAMES;f++) {
   if(a->pos>=p->frames){if(a->loop)a->pos=0;else{a->id=0;break;}}
   float envelope=a->fade&&a->age<a->fade?(float)a->age/a->fade:1.f;
   if(a->stop){envelope*= (float)a->stop/(a->fade?a->fade:1);if(!--a->stop){a->id=0;break;}}
   float gain=a->gain*s->gain*envelope;
   float l=p->pcm[a->pos*2]*gain,r=p->pcm[a->pos*2+1]*gain;
   for(int b=0;b<6;b++)if(mixers&(1u<<b))for(size_t c=0;c<channels;c++)if(m->output[b].data[c])m->output[b].data[c][f]+=channels==1?(l+r)*.5f:c==0?l:c==1?r:0;
   a->pos++;a->age++;
  }
 }
 for(int b=0;b<6;b++)if(mixers&(1u<<b))for(size_t c=0;c<channels;c++)if(m->output[b].data[c])for(int f=0;f<FRAMES;f++) {float x=m->output[b].data[c][f];m->output[b].data[c][f]=fmaxf(-1,fminf(1,x));}
 UNLOCK(&s->lock);return true;
}
/* Feed OBS's normal input pipeline: audio_mix invokes source_output_audio,
 * preserving monitoring, filters, timestamps and bus routing. audio_render is
 * for composites and bypasses the monitor/capture path. */
static bool mix_audio(void *data,uint64_t *ts,void *out,size_t channels,size_t rate) {
 struct mix m={0};m.output[0]=*(struct plane*)out;return render(data,ts,&m,1,channels,rate);
}
void producer_soundboard_register(void) {struct obs_source_info i={0};i.id="producer_soundboard";i.type=OBS_SOURCE_TYPE_INPUT;i.output_flags=2;i.get_name=name;i.create=create;i.destroy=destroy;i.audio_mix=mix_audio;obs_register_source_s(&i,sizeof(i));}
int producer_soundboard_has(obs_source_t *src,uint64_t id) {struct board*s=obs_obj_get_data(src);LOCK(&s->lock);struct clip*p=find(s,id);if(p)p->used=++s->clock;UNLOCK(&s->lock);return p!=NULL;}
/* Allocate/copy before locking. Retired blocks are freed after unlocking. */
int producer_soundboard_load(obs_source_t *src,uint64_t id,const float *pcm,size_t frames) {
 if(!id||!frames||frames>LIMIT/8)return 0;struct board*s=obs_obj_get_data(src);float *copy=malloc(frames*8);if(!copy)return 0;memcpy(copy,pcm,frames*8);
 float *retired[CLIPS];int n=0;LOCK(&s->lock);if(find(s,id)){UNLOCK(&s->lock);free(copy);return 1;}
 struct clip *slot=NULL;
 for(;;){for(int i=0;i<CLIPS;i++)if(!s->clips[i].id){slot=&s->clips[i];break;}if(slot&&s->bytes+frames*8<=LIMIT)break;
  struct clip *old=NULL;for(int i=0;i<CLIPS;i++)if(s->clips[i].id&&!active(s,s->clips[i].id)&&(!old||s->clips[i].used<old->used))old=&s->clips[i];
  if(!old)break;retired[n++]=old->pcm;s->bytes-=old->frames*8;memset(old,0,sizeof(*old));
 }
 int ok=slot&&s->bytes+frames*8<=LIMIT;if(ok){*slot=(struct clip){id,++s->clock,copy,frames};s->bytes+=frames*8;}
 UNLOCK(&s->lock);for(int i=0;i<n;i++)free(retired[i]);if(!ok)free(copy);return ok;
}
/* mode: 0 restart, 1 toggle, 2 overlap, 3 loop-toggle; 4 stop. */
int producer_soundboard_trigger(obs_source_t*src,uint64_t id,int mode,float gain,unsigned fade_ms) {
 struct board*s=obs_obj_get_data(src);LOCK(&s->lock);bool was=active(s,id);
 if(mode!=2)for(int i=0;i<VOICES;i++)if(s->voices[i].id==id){if((mode==4||((mode==1||mode==3)&&was))&&fade_ms){s->voices[i].fade=fade_ms*48;s->voices[i].stop=fade_ms*48;}else s->voices[i].id=0;}
 if(mode==4||((mode==1||mode==3)&&was)){UNLOCK(&s->lock);return 1;}
 struct clip*p=find(s,id);struct voice*v=NULL;for(int i=0;i<VOICES;i++)if(!s->voices[i].id){v=&s->voices[i];break;}
 if(!p||!v){UNLOCK(&s->lock);return 0;}p->used=++s->clock;*v=(struct voice){.id=id,.gain=gain,.fade=fade_ms*48,.loop=mode==3};UNLOCK(&s->lock);return 1;
}
void producer_soundboard_stop(obs_source_t*src){struct board*s=obs_obj_get_data(src);LOCK(&s->lock);memset(s->voices,0,sizeof(s->voices));UNLOCK(&s->lock);}
void producer_soundboard_gain(obs_source_t*src,float gain){struct board*s=obs_obj_get_data(src);LOCK(&s->lock);s->gain=gain;UNLOCK(&s->lock);}
size_t producer_soundboard_status(obs_source_t*src,uint64_t*ids,size_t cap,size_t*bytes){struct board*s=obs_obj_get_data(src);LOCK(&s->lock);size_t n=0;for(int i=0;i<VOICES&&n<cap;i++)if(s->voices[i].id)ids[n++]=s->voices[i].id;*bytes=s->bytes;UNLOCK(&s->lock);return n;}
