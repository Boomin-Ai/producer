/* Deterministic mixer regressions without OBS/devices. */
#include "../src-tauri/src/live/soundboard.c"
#include <assert.h>
#include <stdio.h>
struct obs_source { void *data; };
void *obs_obj_get_data(void *s){return ((struct obs_source*)s)->data;}
uint64_t os_gettime_ns(void){return 1000000000ULL;}
void obs_register_source_s(const struct obs_source_info*i,size_t n){(void)i;(void)n;}
int main(void){struct obs_source source={create(NULL,NULL)};float pcm[4800*2];for(int i=0;i<9600;i++)pcm[i]=.2f;assert(producer_soundboard_load(&source,1,pcm,4800));float planes[2][2][FRAMES]={0};struct mix m={0};for(int b=0;b<2;b++)for(int c=0;c<2;c++)m.output[b].data[c]=planes[b][c];uint64_t ts;
 assert(producer_soundboard_trigger(&source,1,0,1,0));assert(render(source.data,&ts,&m,3,2,48000));assert(fabsf(planes[0][0][200]-.2f)<.0001);assert(planes[0][0][200]==planes[1][0][200]);
 assert(producer_soundboard_trigger(&source,1,2,1,0));render(source.data,&ts,&m,3,2,48000);assert(fabsf(planes[0][0][200]-.4f)<.0001);
 assert(producer_soundboard_trigger(&source,1,1,1,0));render(source.data,&ts,&m,3,2,48000);assert(planes[0][0][200]==0);
 assert(producer_soundboard_trigger(&source,1,3,1,0));for(int i=0;i<20;i++)render(source.data,&ts,&m,3,2,48000);assert(fabsf(planes[0][0][200]-.2f)<.0001);
 producer_soundboard_gain(&source,.5f);render(source.data,&ts,&m,3,2,48000);assert(fabsf(planes[0][0][200]-.1f)<.0001);
 assert(producer_soundboard_trigger(&source,1,4,1,5));render(source.data,&ts,&m,3,2,48000);assert(planes[0][0][500]==0);
 for(int i=0;i<32;i++)assert(producer_soundboard_trigger(&source,1,2,1,0));assert(!producer_soundboard_trigger(&source,1,2,1,0));render(source.data,&ts,&m,3,2,48000);assert(planes[0][0][200]==1);
 producer_soundboard_stop(&source);render(source.data,&ts,&m,3,2,48000);assert(planes[0][0][200]==0);
 for(uint64_t id=2;id<60;id++)assert(producer_soundboard_load(&source,id,pcm,4800));assert(!producer_soundboard_has(&source,1));size_t bytes=0;uint64_t ids[32];assert(producer_soundboard_status(&source,ids,32,&bytes)==0);assert(bytes<=LIMIT);assert(!producer_soundboard_load(&source,60,pcm,LIMIT));
 destroy(source.data);puts("PASS: audience/stage buses, overlap, restart/toggle/loop, level, fade, stop all, voice cap, clipping and cache eviction");}
