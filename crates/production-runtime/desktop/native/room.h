#include <stdint.h>
#include <stddef.h>
typedef void (*NRFrameCallback)(void*, uint32_t, void*, double, uint64_t);
typedef void (*NRAudioCallback)(void*, const float*, uint32_t, double);
typedef void (*NRStatusCallback)(void*, uint32_t, const char*);
typedef struct { float rect[4], uv[4], color[4]; float color_to[4], border[4], metrics[4], surface[4], accent[4], material[4]; float opacity; uint32_t kind, source, reserved; } NRDraw;
typedef struct { int64_t start,duration; int32_t rate,duration_rate; uint32_t media; } NRSpan;
typedef struct { uint32_t width,height,kind; } NRRecordTrack;
typedef int (*NRSegmentCallback)(void*,uint64_t,uint32_t,uint32_t,const void*,size_t,const NRSpan*,size_t);
void *nr_create(void*, NRFrameCallback, NRAudioCallback, NRStatusCallback);
char *nr_cameras(void);
void nr_camera_device(void*,const char*);
void nr_capture(void*, int, int, int);
void nr_capture_stop(void*, int);
typedef struct { const char *value; uint32_t width,height; float font_size; uint32_t weight,align; } NRText;
void *nr_text_cache(const NRText*,size_t);
void nr_text_cache_release(void*);
void nr_stop(void*);
int nr_render(void*, uint32_t, uint32_t, uint32_t, const NRDraw*, size_t, void**, void*, double, uint64_t);
int nr_record_start(void*, uint64_t, double, const NRRecordTrack*, size_t, NRSegmentCallback);
void nr_record_stop(void*);
void nr_record_audio(void*, const float*, const float*, uint32_t, double);
void *nr_movie_open(const char*, double*);
void *nr_movie_frame(void*, double, uint64_t);
void nr_movie_close(void*);
void nr_movie_cancel(void*);
double nr_host_time(void);

double nr_movie_start(void *movie);
double nr_audio_start(void *audio);

char *nr_microphones(void);
void nr_mic_device(void*,const char*);
void *nr_input_create(void*, NRFrameCallback, NRAudioCallback, NRStatusCallback, int, const char*);
void nr_input_stop(void*);
