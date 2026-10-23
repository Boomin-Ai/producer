/* Native prepared-surface assembly. This is an in-process owner API, never an
 * IPC format. The caller resolves authorized media/graphics/shader sources and
 * keeps those references alive during prepare. The resulting graph retains its
 * own refs. It is detached from room output until an output owner takes it. */
#ifndef PRODUCER_SET_V2_SCENE_H
#define PRODUCER_SET_V2_SCENE_H
#include "group.h"
#ifdef __cplusplus
extern "C" {
#endif
enum producer_set_v2_fit { SET_V2_STRETCH, SET_V2_CONTAIN, SET_V2_COVER };
enum producer_set_v2_node_kind { SET_V2_GROUP, SET_V2_SURFACE };
struct producer_set_v2_node {
  const char *id;
  enum producer_set_v2_node_kind kind;
  float x, y, width, height, radius, opacity;
  bool visible;
  enum producer_set_v2_fit fit;
  obs_source_t *surface;
  const struct producer_set_v2_node *children;
  size_t child_count;
};
struct producer_set_v2_scene;
struct producer_set_v2_scene *producer_set_v2_scene_prepare(
    const struct producer_set_v2_node *root, uint32_t output_width,
    uint32_t output_height, enum producer_set_v2_fit output_fit,
    size_t texture_byte_budget, char *error, size_t error_capacity);
/* Borrowed refs, valid until release. Node groups are placement-local wrappers.
 */
obs_source_t *producer_set_v2_scene_source(struct producer_set_v2_scene *scene);
obs_source_t *producer_set_v2_scene_node(struct producer_set_v2_scene *scene,
                                         const char *id);
size_t producer_set_v2_scene_texture_bytes(struct producer_set_v2_scene *scene);
size_t producer_set_v2_scene_group_count(struct producer_set_v2_scene *scene);
void producer_set_v2_scene_release(struct producer_set_v2_scene *scene);
#ifdef __cplusplus
}
#endif
#endif
