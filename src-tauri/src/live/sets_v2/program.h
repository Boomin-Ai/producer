#ifndef PRODUCER_SET_V2_PROGRAM_H
#define PRODUCER_SET_V2_PROGRAM_H
#include "transition.h"
#ifdef __cplusplus
extern "C" {
#endif
struct producer_set_v2_program_status {
  uint64_t prepared_revision, rendered_revision, render_serial;
  double clock_ms, transition_progress;
  bool warmed, ready, queued, transitioning, paused;
};
void producer_set_v2_program_register(void);
obs_source_t *producer_set_v2_program_create(uint32_t width, uint32_t height);
/* Serialized native owner calls. The source is video-only and detached until
 * attached by the room owner. prepare retains the candidate, never shows it.
 * No source pointer is accepted from imported set data or IPC. */
bool producer_set_v2_program_prepare(obs_source_t *program,
                                     obs_source_t *candidate,
                                     uint64_t revision);
/* Resource service must confirm first paint/frame readiness independently.
 * A texture allocation or nonzero source dimensions is not that confirmation.
 */
bool producer_set_v2_program_ready(obs_source_t *program, uint64_t revision);
bool producer_set_v2_program_take(obs_source_t *program, uint64_t revision,
                                  double duration_ms,
                                  enum producer_set_v2_transition_mode mode);
bool producer_set_v2_program_cancel(obs_source_t *program, uint64_t revision);
bool producer_set_v2_program_pause(obs_source_t *program, bool paused);
bool producer_set_v2_program_status(obs_source_t *program,
                                    struct producer_set_v2_program_status *out);
/* Owner-thread cleanup after a completed rendered receipt. Outgoing refs stay
 * alive until the transition has rendered its endpoint. */
bool producer_set_v2_program_collect(obs_source_t *program);
size_t producer_set_v2_live_programs(void);
struct producer_set_v2_scene;
struct producer_set_v2_keyframe {
  double at_ms;
  float value;
};
bool producer_set_v2_program_track(
    obs_source_t *program, uint64_t revision,
    struct producer_set_v2_scene *scene, const char *target,
    obs_source_t *shader, int property,
    const struct producer_set_v2_keyframe *frames, size_t count, int easing,
    int loop, double base_ms, double delay_ms, bool running);
bool producer_set_v2_program_shader(obs_source_t *program, uint64_t revision,
                                    obs_source_t *shader, float intensity,
                                    float scale, float opacity, double base_ms,
                                    bool running);
bool producer_set_v2_program_chart(obs_source_t *program,uint64_t revision,obs_source_t *chart);
bool producer_set_v2_program_media(obs_source_t *program, uint64_t revision,
                                   obs_source_t *media, bool playing,
                                   double position_ms);

/* Stop borrowing scene metadata before the room owner releases it. */
void producer_set_v2_program_stop_motion(obs_source_t *source);

bool producer_set_v2_program_cached_ready(obs_source_t *source, uint64_t revision);
#ifdef __cplusplus
}
#endif
#endif
