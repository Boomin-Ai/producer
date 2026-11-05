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
/* Validate one scene's immutable paint markers in one graphics task. */
bool producer_set_v2_surface_markers(obs_source_t *const *sources,
                                   const uint32_t *rows, size_t count);
/* Return actual verified prefix progress, stopping at the first unpainted
 * marker. A true return validates the request, not the whole scene. On invalid
 * input no task is queued and a nonnull output is reset to zero. The caller
 * may retain each receipt only while that immutable source stays leased. */
bool producer_set_v2_surface_marker_progress(obs_source_t *const *sources,
                                            const uint32_t *rows, size_t count,
                                            size_t *verified_prefix);
bool producer_set_v2_surfaces_warm(obs_source_t *const *sources, size_t count);
#endif
