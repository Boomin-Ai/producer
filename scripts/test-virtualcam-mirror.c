#include "virtualcam-mirror.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
int main(void) {
 // Two rows, odd width, and different row padding. Each BGRA pixel has a
 // distinct alpha too, so reversal cannot accidentally swap color channels.
 uint8_t src[40], dst[48], restored[40];
 memset(src,0xEE,sizeof(src));memset(dst,0xCC,sizeof(dst));memset(restored,0xDD,sizeof(restored));
 for (size_t y=0;y<2;y++) for(size_t x=0;x<3;x++) for(size_t c=0;c<4;c++)src[y*20+x*4+c]=(uint8_t)(y*60+x*8+c);
 assert(producer_mirror_bgra(src,20,dst,24,3,2)==kvImageNoError);
 for(size_t y=0;y<2;y++)for(size_t x=0;x<3;x++)assert(memcmp(dst+y*24+x*4,src+y*20+(2-x)*4,4)==0);
 for(size_t y=0;y<2;y++)for(size_t x=12;x<24;x++)assert(dst[y*24+x]==0xCC);
 assert(producer_mirror_bgra(dst,24,restored,20,3,2)==kvImageNoError);
 for(size_t y=0;y<2;y++)assert(memcmp(src+y*20,restored+y*20,12)==0);
 puts("PASS: horizontal BGRA mirror preserves rows, padding, channels and alpha; double reflection restores the frame");
}
