/* Internal native RTC media boundary. No tokens, room control or device owners.
 * Caller owns a live OBS source until all delivery calls/workers have stopped.
 * OBS copies submitted media; these functions retain no buffers or callbacks. */
#ifndef PRODUCER_GUEST_INGEST_H
#define PRODUCER_GUEST_INGEST_H
#include "obs_min.h"
#ifdef __cplusplus
extern "C" {
#endif
#define PRODUCER_GUEST_INGEST_ID "producer_guest_ingest"
void producer_guest_ingest_register(void);
bool producer_guest_ingest_video(obs_source_t *source,
    const uint8_t *y, size_t y_len, const uint8_t *u, size_t u_len,
    const uint8_t *v, size_t v_len, uint32_t width, uint32_t height,
    uint32_t ys, uint32_t us, uint32_t vs, uint64_t timestamp);
bool producer_guest_ingest_audio(obs_source_t *source, const int16_t *pcm,
    size_t sample_count, uint32_t channels, uint64_t timestamp);
#ifdef __cplusplus
}
#endif
#endif
