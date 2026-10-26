#ifndef PRODUCER_SET_V2_READINESS_H
#define PRODUCER_SET_V2_READINESS_H
#include "group.h"
/* Read a reserved graphics-source marker pixel. The extra marker row is
 * excluded from its visible placement. This confirms an actual browser paint,
 * not just nonzero dimensions. Owner-thread API: synchronously queues rendering on the OBS graphics thread.
 * Never call while holding a graphics lock or from a render callback.
 */
bool producer_set_v2_surface_marker(obs_source_t *source, uint32_t x,
                                    uint32_t y, uint8_t red, uint8_t green,
                                    uint8_t blue);
bool producer_set_v2_surface_warm(obs_source_t *source);
bool producer_set_v2_surface_fence(obs_source_t *source, uint32_t y, const uint8_t *expected);
#endif
