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
#ifdef __cplusplus
}
#endif
#endif
