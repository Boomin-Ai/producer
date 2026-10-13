#include <assert.h>
#include <stdio.h>
#include "../../src-tauri/src/live/guest_ingest.c"
static uint64_t clock_ns = 1000000000ULL;
uint64_t os_gettime_ns(void) { return clock_ns; }
void *obs_obj_get_data(void *source) { return source; }
void obs_register_source_s(const struct obs_source_info *info, size_t size) { (void)info; (void)size; }
void obs_source_output_video(obs_source_t *source, const struct obs_source_frame *frame) { (void)source; (void)frame; }
void obs_source_output_audio(obs_source_t *source, const struct obs_source_audio *audio) { (void)source; (void)audio; assert(!"Guest audio must use pull rendering"); }
bool video_format_get_parameters(int a, int b, float c[16], float d[3], float e[3]) { (void)a;(void)b;(void)c;(void)d;(void)e;return true; }
int main(void) {
 struct guest_state *state = create(NULL,NULL);assert(state);
 float left[1024],right[1024];struct guest_audio_mix mix={0};mix.output[0].data[0]=left;mix.output[0].data[1]=right;
 int16_t pcm[960];for(size_t i=0;i<960;i++)pcm[i]=8192;
 uint64_t ts=0;
 assert(producer_guest_ingest_audio((obs_source_t *)state,pcm,960,2,clock_ns-GUEST_RENDER_DELAY_NS));
 assert(render_audio(state,&ts,&mix,1,2,48000));assert(ts==940000000ULL);assert(left[0]==0.25f&&right[0]==0.25f);assert(left[600]==0);
 clock_ns+=frames_ns(1024);uint64_t previous=ts;
 assert(render_audio(state,&ts,&mix,1,2,48000));assert(ts>previous);for(size_t i=0;i<1024;i++)assert(left[i]==0&&right[i]==0);
 /* An eight-second network gap never makes the mixer wait or replays PCM. */
 previous=ts;
 for(size_t tick=0;tick<375;tick++) {
  clock_ns+=frames_ns(1024);assert(render_audio(state,&ts,&mix,1,2,48000));
  for(size_t i=0;i<1024;i++)assert(left[i]==0&&right[i]==0);
 }
 assert(ts-previous>=7999999999ULL&&ts-previous<=8000000001ULL);
 /* Fresh PCM resumes on the same render timeline after the network gap. */
 uint64_t resume=state->anchor+frames_ns(state->rendered);
 assert(producer_guest_ingest_audio((obs_source_t *)state,pcm,960,2,resume));
 clock_ns+=frames_ns(1024);assert(render_audio(state,&ts,&mix,1,2,48000));assert(ts==resume&&left[0]==0.25f&&right[0]==0.25f);
 for(size_t i=0;i<GUEST_AUDIO_QUEUE;i++)assert(producer_guest_ingest_audio((obs_source_t *)state,pcm,960,2,clock_ns+i*10000000ULL));
 assert(!producer_guest_ingest_audio((obs_source_t *)state,pcm,960,2,clock_ns));
 producer_guest_ingest_clear_audio((obs_source_t *)state);assert(state->count==0);
 clock_ns+=frames_ns(1024);assert(render_audio(state,&ts,&mix,1,2,48000));for(size_t i=0;i<1024;i++)assert(left[i]==0&&right[i]==0);
 /* The render thread must return silence instead of blocking on ingestion. */
 pthread_mutex_lock(&state->lock);assert(render_audio(state,&ts,&mix,1,2,48000));pthread_mutex_unlock(&state->lock);
 destroy(state);puts("Guest pull-audio proof passed: gaps, overflow, invalidation, lock contention");
}
