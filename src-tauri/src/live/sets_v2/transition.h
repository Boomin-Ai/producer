#ifndef PRODUCER_SET_V2_TRANSITION_H
#define PRODUCER_SET_V2_TRANSITION_H
#include "../obs_min.h"
#ifdef __cplusplus
extern "C" {
#endif
enum producer_set_v2_transition_mode {
  PRODUCER_SET_V2_DISSOLVE,
  PRODUCER_SET_V2_WIPE,
  PRODUCER_SET_V2_SLIDE
};
void producer_set_v2_transition_register(void);
/* Off-air native owner only. Inputs remain live and are reference-counted. */
obs_source_t *
producer_set_v2_transition_create(obs_source_t *from, obs_source_t *to,
                                  uint32_t width, uint32_t height,
                                  enum producer_set_v2_transition_mode mode);
/* Native graphics context only; progress comes from the presentation clock. */
bool producer_set_v2_transition_frame(obs_source_t *source, float progress);
size_t producer_set_v2_live_transitions(void);
#ifdef __cplusplus
}
#endif
#endif
