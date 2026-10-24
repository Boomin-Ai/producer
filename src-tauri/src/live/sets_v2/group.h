/* Sets v2 native ordered group. Trusted native owner API, not an IPC surface.
 * Build off air, add ordered source references, then seal before use. */
#ifndef PRODUCER_SET_V2_GROUP_H
#define PRODUCER_SET_V2_GROUP_H
#include "../obs_min.h"
#ifdef __cplusplus
extern "C" {
#endif
void producer_set_v2_register(void);
obs_source_t *producer_set_v2_group_create(uint32_t width, uint32_t height,
                                           float radius, float opacity);
/* Set physical raster density before sealing; logical coordinates stay fixed. */
bool producer_set_v2_group_density(obs_source_t *group, float density);
bool producer_set_v2_group_add(obs_source_t *group, obs_source_t *child,
                               float x, float y, float width, float height,
                               bool contain);
bool producer_set_v2_group_seal(obs_source_t *group);
/* In graphics context only; geometry belongs to this placement/group, not
 * shared capture. */
bool producer_set_v2_group_frame(obs_source_t *group, float radius,
                                 float opacity);
/* Native graphics context only. Changes this placement without changing the
 * shared capture source or its other placements. Child ownership/order is
 * fixed. */
bool producer_set_v2_group_layer_frame(obs_source_t *group, size_t index,
                                       float x, float y, float width,
                                       float height, bool visible);
size_t producer_set_v2_live_groups(void);
bool producer_set_v2_group_layer_transform(obs_source_t *group, size_t index,
                                           float rotation, float scale_x,
                                           float scale_y);
#ifdef __cplusplus
}
#endif
#endif
