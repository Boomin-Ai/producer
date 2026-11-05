/* Trusted immutable 2D graphics snapshot. No IPC or dynamic-source API. */
#ifndef PRODUCER_SET_V2_RASTER_H
#define PRODUCER_SET_V2_RASTER_H
#include "../obs_min.h"
#ifdef __cplusplus
extern "C" {
#endif
void producer_set_v2_raster_register(void);
/* Known logical dimensions; no pixels are visible until capture succeeds.
 * The compositor shader is initialized synchronously before success. */
obs_source_t *producer_set_v2_raster_create(uint32_t logical_width,
                                           uint32_t logical_height,
                                           float density);
/* One construction receipt, available only after create() succeeds. Offsets
 * are measured from that C call's entry, not a cross-runtime clock epoch.
 * texrender_create measures its CPU wrapper, not the deferred GPU allocation.
 * No rendering/capture state changes; an invalid or consumed receipt is zeroed. */
struct producer_set_v2_raster_creation_stats {
  uint64_t elapsed_ns;
  uint64_t graphics_wait_offset_ns, graphics_wait_ns;
  uint64_t effect_compile_offset_ns, effect_compile_ns;
  uint64_t texrender_create_offset_ns, texrender_create_ns;
  uint64_t effect_compiled;
};
bool producer_set_v2_raster_take_creation_stats(
    obs_source_t *snapshot, struct producer_set_v2_raster_creation_stats *out);
/* Owner thread only, with NO graphics context held and never on the graphics
 * thread. Input is trusted immutable encoded-SDR graphics, exactly
 * max(ceil(logical_width*density),6) by (ceil(logical_height*density)+1).
 * Its final row begins with six opaque RGB pixels from get_marker().
 * Retains both sources through one synchronous graphics task. The visible
 * image and marker are copied to an owned RGBA target. A fresh private GPU
 * nonce after the input's six marker pixels must also survive staging before
 * completion is trusted. Both fences stay outside the authored image.
 * Successful copies retain no input. A completed copy with an absent browser
 * marker is safely retryable; ready copies cannot be overwritten.
 * If completion cannot be proved, one bounded terminal quarantine retains
 * both sources and the input's active/showing leases; further capture is
 * disabled until process restart. False never exposes partial pixels.
 * Never call this for a live, moving or mutable source. */
bool producer_set_v2_raster_capture(obs_source_t *snapshot, obs_source_t *input);
bool producer_set_v2_raster_get_marker(obs_source_t *snapshot, uint8_t *out18);
bool producer_set_v2_raster_ready(obs_source_t *snapshot);
bool producer_set_v2_raster_copy_blocked(void);
size_t producer_set_v2_raster_quarantine_count(void);
/* Requested resident RGBA payload only (zero before target allocation).
 * Excludes driver overhead, shared shader, and transient full-image staging. */
size_t producer_set_v2_raster_texture_bytes(obs_source_t *snapshot);
#ifdef PRODUCER_SET_V2_PROBE
/* Pure timing arithmetic proof; does not initialize or call graphics. */
bool producer_set_v2_raster_probe_creation_stats_bounds(void);
/* Bounded weak observer only; no strong browser ownership or product counters. */
size_t producer_set_v2_raster_probe_live_inputs(void);
size_t producer_set_v2_raster_probe_tracked_inputs(void);
size_t producer_set_v2_raster_probe_input_overflow(void);
/* One next-copy fault, isolated probe only: 1=allocation, 2=input render no-op,
 * 3=stage-copy no-op, 4=map failure. Recovery only releases quarantine after
 * a new actual stage/map observes its retained completion nonce. */
void producer_set_v2_raster_probe_fail_next(int fault);
bool producer_set_v2_raster_probe_recover_quarantine(void);
#endif
#ifdef __cplusplus
}
#endif
#endif
