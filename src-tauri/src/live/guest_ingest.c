/* OBS ABI pinned to engine/obs.lock, 32.1.2 libobs/obs.h. Recheck on bump.
 * Shared by the isolated RTC lab and the opt-in native adapter build. */
#include "guest_ingest.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#define MAX_AV_PLANES 8
struct obs_source_frame {
    uint8_t *data[MAX_AV_PLANES]; uint32_t linesize[MAX_AV_PLANES];
    uint32_t width, height; uint64_t timestamp;
    int format; float color_matrix[16]; bool full_range; uint16_t max_luminance;
    float color_range_min[3], color_range_max[3]; bool flip; uint8_t flags, trc;
    volatile long refs; bool prev_frame;
};
struct obs_source_audio {
    const uint8_t *data[MAX_AV_PLANES]; uint32_t frames;
    int speakers, format; uint32_t samples_per_sec; uint64_t timestamp;
};
OBS_IMPORT void obs_source_output_video(obs_source_t *, const struct obs_source_frame *);
OBS_IMPORT void obs_source_output_audio(obs_source_t *, const struct obs_source_audio *);
OBS_IMPORT bool video_format_get_parameters(int, int, float[16], float[3], float[3]);
/* OBS pulls a continuous clock from each guest, including silence during
 * packet gaps. Guest push timestamps never control the shared mixer clock. */
#define GUEST_AUDIO_QUEUE 16
#define GUEST_AUDIO_FRAMES 4800
#define GUEST_RENDER_FRAMES 1024
#define GUEST_RENDER_DELAY_NS 60000000ULL
struct guest_audio_block { uint64_t timestamp; size_t frames; uint32_t channels; int16_t pcm[GUEST_AUDIO_FRAMES * 2]; };
struct guest_state {
    pthread_mutex_t lock;
    struct guest_audio_block blocks[GUEST_AUDIO_QUEUE];
    size_t head, count;
    uint64_t anchor, rendered;
};
struct guest_audio_plane { float *data[8]; };
struct guest_audio_mix { struct guest_audio_plane output[6]; };
OBS_IMPORT void *obs_obj_get_data(void *);
OBS_IMPORT uint64_t os_gettime_ns(void);
static const char *name(void *unused) { (void)unused; return "Producer guest"; }
static void *create(obs_data_t *settings, obs_source_t *source) {
    (void)settings; (void)source;
    struct guest_state *state = calloc(1, sizeof(*state));
    if (!state) return NULL;
    if (pthread_mutex_init(&state->lock, NULL)) { free(state); return NULL; }
    return state;
}
static void destroy(void *data) {
    struct guest_state *state = data;
    if (state) { pthread_mutex_destroy(&state->lock); free(state); }
}
static uint64_t frames_ns(uint64_t frames) { return frames / 48000 * 1000000000ULL + frames % 48000 * 1000000000ULL / 48000; }
static bool render_audio(void *data, uint64_t *ts, void *output, uint32_t mixers, size_t channels, size_t rate) {
    struct guest_state *state = data;
    struct guest_audio_mix *mix = output;
    if (!state || !ts || !mix || rate != 48000 || !channels || channels > 8) return false;
    uint64_t now = os_gettime_ns();
    uint64_t base = now > GUEST_RENDER_DELAY_NS ? now - GUEST_RENDER_DELAY_NS : 1;
    if (!state->anchor || base > state->anchor + frames_ns(state->rendered) + 100000000ULL) {
        state->anchor = base; state->rendered = 0;
    }
    *ts = state->anchor + frames_ns(state->rendered);
    state->rendered += GUEST_RENDER_FRAMES;
    /* No allocation, blocking locks, or SDK calls on the OBS audio thread. */
    for (size_t m = 0; m < 6; m++) if (mixers & (1U << m))
        for (size_t c = 0; c < channels; c++) if (mix->output[m].data[c])
            memset(mix->output[m].data[c], 0, GUEST_RENDER_FRAMES * sizeof(float));
    if (pthread_mutex_trylock(&state->lock)) return true;
    for (size_t i = 0; i < GUEST_RENDER_FRAMES; i++) {
        uint64_t at = *ts + frames_ns(i);
        while (state->count) {
            struct guest_audio_block *block = &state->blocks[state->head];
            if (at < block->timestamp + frames_ns(block->frames)) break;
            state->head = (state->head + 1) % GUEST_AUDIO_QUEUE; state->count--;
        }
        if (!state->count) break;
        struct guest_audio_block *block = &state->blocks[state->head];
        if (at < block->timestamp) continue;
        size_t frame = (size_t)(((at - block->timestamp) * 48000 + 500000000ULL) / 1000000000ULL);
        if (frame >= block->frames) continue;
        for (size_t m = 0; m < 6; m++) if (mixers & (1U << m))
            for (size_t c = 0; c < channels; c++) if (mix->output[m].data[c]) {
                float value = block->pcm[frame * block->channels + (block->channels == 2 && c == 1 ? 1 : 0)] / 32768.0f;
                if (channels == 1 && block->channels == 2) value = (block->pcm[frame*2] + block->pcm[frame*2+1]) / 65536.0f;
                mix->output[m].data[c][i] = c < 2 ? value : 0.0f;
            }
    }
    pthread_mutex_unlock(&state->lock);
    return true;
}
void producer_guest_ingest_clear_audio(obs_source_t *source) {
    struct guest_state *state = source ? obs_obj_get_data(source) : NULL;
    if (!state) return;
    pthread_mutex_lock(&state->lock); state->head = state->count = 0; pthread_mutex_unlock(&state->lock);
}
void producer_guest_ingest_register(void) {
    struct obs_source_info info = {0};
    info.id = PRODUCER_GUEST_INGEST_ID; info.type = OBS_SOURCE_TYPE_INPUT;
    info.output_flags = (1 << 0) | (1 << 1) | (1 << 2); /* video, audio, async */
    info.get_name = name; info.create = create; info.destroy = destroy; info.audio_render = render_audio;
    obs_register_source_s(&info, sizeof(info));
}
static bool plane_ok(const uint8_t *p, size_t length, uint32_t stride,
                     uint32_t width, uint32_t height) {
    /* Require full stride rows: OBS copies row storage, including padding.
     * Both axes support portrait/UHD; cap stride and dimensions before math. */
    return p && stride >= width && stride <= 8192 &&
           length >= (uint64_t)stride * height;
}
bool producer_guest_ingest_video(obs_source_t *source,
    const uint8_t *y, size_t y_len, const uint8_t *u, size_t u_len,
    const uint8_t *v, size_t v_len, uint32_t width, uint32_t height,
    uint32_t ys, uint32_t us, uint32_t vs, uint64_t timestamp) {
    if (!source || !timestamp || !width || !height || width > 4096 || height > 4096)
        return false;
    uint32_t cw = (width + 1) / 2, ch = (height + 1) / 2;
    if (!plane_ok(y, y_len, ys, width, height) ||
        !plane_ok(u, u_len, us, cw, ch) || !plane_ok(v, v_len, vs, cw, ch))
        return false;
    struct obs_source_frame frame = {0};
    frame.data[0] = (uint8_t *)y; frame.data[1] = (uint8_t *)u; frame.data[2] = (uint8_t *)v;
    frame.linesize[0] = ys; frame.linesize[1] = us; frame.linesize[2] = vs;
    frame.width = width; frame.height = height; frame.timestamp = timestamp;
    frame.format = 1; /* I420; BT.709, limited range */
    if (!video_format_get_parameters(2, 1, frame.color_matrix, frame.color_range_min, frame.color_range_max))
        return false;
    obs_source_output_video(source, &frame);
    return true;
}
bool producer_guest_ingest_audio(obs_source_t *source, const int16_t *pcm,
    size_t sample_count, uint32_t channels, uint64_t timestamp) {
    if (!source || !pcm || !timestamp || (channels != 1 && channels != 2) ||
        !sample_count || sample_count % channels || sample_count / channels > 4800)
        return false; /* 48 kHz, at most 100 ms per submission. */
    struct guest_state *state = obs_obj_get_data(source);
    if (!state || pthread_mutex_trylock(&state->lock)) return false;
    if (state->count == GUEST_AUDIO_QUEUE) { pthread_mutex_unlock(&state->lock); return false; }
    struct guest_audio_block *block = &state->blocks[(state->head + state->count) % GUEST_AUDIO_QUEUE];
    block->timestamp = timestamp; block->frames = sample_count / channels; block->channels = channels;
    memcpy(block->pcm, pcm, sample_count * sizeof(int16_t)); state->count++;
    pthread_mutex_unlock(&state->lock);
    return true;
}
