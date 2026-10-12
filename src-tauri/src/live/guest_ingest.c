/* OBS ABI pinned to engine/obs.lock, 32.1.2 libobs/obs.h. Recheck on bump.
 * Shared by the isolated RTC lab and the opt-in native adapter build. */
#include "guest_ingest.h"
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
static const char *name(void *unused) { (void)unused; return "Producer guest"; }
static void *create(obs_data_t *settings, obs_source_t *source) { (void)settings; return source; }
static void destroy(void *unused) { (void)unused; }
void producer_guest_ingest_register(void) {
    struct obs_source_info info = {0};
    info.id = PRODUCER_GUEST_INGEST_ID; info.type = OBS_SOURCE_TYPE_INPUT;
    info.output_flags = (1 << 0) | (1 << 1) | (1 << 2); /* video, audio, async */
    info.get_name = name; info.create = create; info.destroy = destroy;
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
    struct obs_source_audio audio = {0};
    audio.data[0] = (const uint8_t *)pcm; audio.frames = (uint32_t)(sample_count / channels);
    audio.speakers = channels == 2 ? 2 : 1; audio.format = 2; audio.samples_per_sec = 48000;
    audio.timestamp = timestamp; obs_source_output_audio(source, &audio);
    return true;
}
