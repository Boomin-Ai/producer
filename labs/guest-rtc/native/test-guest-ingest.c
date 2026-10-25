/* Invalid RTC buffers must never reach the OBS copy path. Compile standalone:
 * clang -std=c11 -Wall -Wextra -Werror native/test-guest-ingest.c -o runtime/test-guest-ingest
 * Fake OBS observes calls; the separate real OBS lifecycle checks ABI/linkage. */
#include <assert.h>
#include <string.h>
#include "../../../src-tauri/src/live/guest_ingest.c"
static unsigned audio_calls, video_calls, registrations;
static bool matrix_ok = true;
void obs_register_source_s(const struct obs_source_info *info, size_t size) {
    assert(size == sizeof(*info));
    assert(!strcmp(info->id, PRODUCER_GUEST_INGEST_ID));
    assert(info->output_flags == 7);
    assert(info->create(NULL, (obs_source_t *)1) == (obs_source_t *)1);
    info->destroy(NULL); ++registrations;
}
bool video_format_get_parameters(int colorspace, int range, float matrix[16], float min[3], float max[3]) {
    assert(colorspace == 2 && range == 1);
    (void)matrix; (void)min; (void)max; return matrix_ok;
}
void obs_source_output_video(obs_source_t *source, const struct obs_source_frame *frame) {
    assert(source == (obs_source_t *)1 && frame->timestamp == 123);
    assert(frame->width == 3 && frame->height == 3 && frame->format == 1);
    assert(frame->linesize[0] == 4 && frame->linesize[1] == 2 && frame->linesize[2] == 2);
    assert(!frame->full_range); ++video_calls;
}
void obs_source_output_audio(obs_source_t *source, const struct obs_source_audio *audio) {
    assert(source == (obs_source_t *)1 && audio->timestamp == 123);
    assert(audio->frames == 480 && audio->samples_per_sec == 48000 && audio->format == 2);
    assert(audio->speakers == 1 || audio->speakers == 2); ++audio_calls;
}
int main(void) {
    obs_source_t *source = (obs_source_t *)1;
    uint8_t y[12] = {0}, uv[4] = {0}; int16_t pcm[960] = {0};
    producer_guest_ingest_register(); assert(registrations == 1);
    assert(producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, 3, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 11, uv, 4, uv, 4, 3, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 3, uv, 4, 3, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 3, 3, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, 3, 3, 2, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, 0, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, UINT32_MAX, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, 3, 3, UINT32_MAX, 2, 2, 123));
    assert(!producer_guest_ingest_video(NULL, y, 12, uv, 4, uv, 4, 3, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, NULL, 12, uv, 4, uv, 4, 3, 3, 4, 2, 2, 123));
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, 3, 3, 4, 2, 2, 0));
    matrix_ok = false;
    assert(!producer_guest_ingest_video(source, y, 12, uv, 4, uv, 4, 3, 3, 4, 2, 2, 123));
    assert(video_calls == 1);
    assert(producer_guest_ingest_audio(source, pcm, 480, 1, 123));
    assert(producer_guest_ingest_audio(source, pcm, 960, 2, 123));
    assert(!producer_guest_ingest_audio(source, pcm, 959, 2, 123));
    assert(!producer_guest_ingest_audio(source, pcm, 960, 3, 123));
    assert(!producer_guest_ingest_audio(source, pcm, 4801, 1, 123));
    assert(!producer_guest_ingest_audio(source, pcm, SIZE_MAX, 2, 123));
    assert(!producer_guest_ingest_audio(source, pcm, 0, 1, 123));
    assert(!producer_guest_ingest_audio(source, NULL, 480, 1, 123));
    assert(!producer_guest_ingest_audio(NULL, pcm, 480, 1, 123));
    assert(!producer_guest_ingest_audio(source, pcm, 480, 1, 0));
    assert(audio_calls == 2);
    return 0;
}
