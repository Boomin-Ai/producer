#include "scene.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NODE_LIMIT 128
#define DEPTH_LIMIT 12
#define BYTE_LIMIT (256u * 1024u * 1024u)
struct owned_node {
  char id[65];
  obs_source_t *group;
};
struct producer_set_v2_scene {
  obs_source_t *root;
  struct owned_node nodes[NODE_LIMIT];
  size_t count, bytes, groups;
};
struct preparation {
  struct producer_set_v2_scene *scene;
  size_t budget;
  char *error;
  size_t capacity;
};
static bool fail(struct preparation *p, const char *message) {
  if (p->error && p->capacity)
    snprintf(p->error, p->capacity, "%s", message);
  return false;
}
static bool fit_valid(enum producer_set_v2_fit fit) {
  return fit >= SET_V2_STRETCH && fit <= SET_V2_COVER;
}
static bool allocation(struct preparation *p, double width, double height) {
  double w = ceil(width), h = ceil(height);
  if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > 8192 || h > 8192 ||
      w * h > 4096u * 4096u)
    return fail(p, "Native texture dimensions exceeded");
  size_t bytes = (size_t)w * (size_t)h * 4;
  if (p->scene->bytes > p->budget || bytes > p->budget - p->scene->bytes)
    return fail(p, "Native scene texture budget exceeded");
  p->scene->bytes += bytes;
  p->scene->groups++;
  return true;
}
/* Preflight the complete tree before creating any native group. This budget is
 * for requested RGBA texrender color targets, not driver/CEF/decoder memory. */
static bool validate(struct preparation *p,
                     const struct producer_set_v2_node *n, unsigned depth) {
  if (!n || depth > DEPTH_LIMIT || p->scene->count >= NODE_LIMIT)
    return fail(p, "Native scene node/depth budget exceeded");
  if (!n->id || !n->id[0] || strlen(n->id) > 64)
    return fail(p, "Invalid native node identity");
  for (const char *c = n->id; *c; c++)
    if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') ||
          (*c >= '0' && *c <= '9') || *c == '-' || *c == '_'))
      return fail(p, "Invalid native node identity");
  for (size_t i = 0; i < p->scene->count; i++)
    if (!strcmp(p->scene->nodes[i].id, n->id))
      return fail(p, "Duplicate native node identity");
  if (!isfinite(n->x) || !isfinite(n->y) || fabsf(n->x) > 16384 ||
      fabsf(n->y) > 16384 || !isfinite(n->radius) || n->radius < 0 ||
      n->radius > 8192 || !isfinite(n->opacity) || n->opacity < 0 ||
      n->opacity > 1 || !fit_valid(n->fit))
    return fail(p, "Invalid native node geometry/style");
  if (!allocation(p, n->width, n->height))
    return false;
  snprintf(p->scene->nodes[p->scene->count++].id, 65, "%s", n->id);
  if (n->kind == SET_V2_GROUP) {
    if (n->surface || n->child_count > 128 || (n->child_count && !n->children))
      return fail(p, "Invalid native group children");
    for (size_t i = 0; i < n->child_count; i++)
      if (!validate(p, &n->children[i], depth + 1))
        return false;
  } else if (n->kind == SET_V2_SURFACE) {
    if (n->child_count || n->children || !n->surface ||
        !(obs_source_get_output_flags(n->surface) & OBS_SOURCE_VIDEO) ||
        !obs_source_get_width(n->surface) || !obs_source_get_height(n->surface))
      return fail(p, "Native surface is not ready");
  } else
    return fail(p, "Unknown native node kind");
  return true;
}
static bool place(obs_source_t *group, obs_source_t *surface, float x, float y,
                  float w, float h, enum producer_set_v2_fit fit) {
  uint32_t sw = obs_source_get_width(surface),
           sh = obs_source_get_height(surface);
  if (!sw || !sh)
    return false;
  if (fit == SET_V2_COVER) {
    float scale = fmaxf(w / sw, h / sh);
    return producer_set_v2_group_add(group, surface, x + (w - sw * scale) * .5f,
                                     y + (h - sh * scale) * .5f, sw * scale,
                                     sh * scale, false);
  }
  return producer_set_v2_group_add(group, surface, x, y, w, h,
                                   fit == SET_V2_CONTAIN);
}
static obs_source_t *assemble(struct preparation *p,
                              const struct producer_set_v2_node *n,
                              size_t *index) {
  size_t own = (*index)++;
  uint32_t w = (uint32_t)ceilf(n->width), h = (uint32_t)ceilf(n->height);
  obs_source_t *group = producer_set_v2_group_create(
      w, h, n->radius, n->visible ? n->opacity : 0);
  if (!group) {
    fail(p, "Native group allocation failed");
    return NULL;
  }
  p->scene->nodes[own].group =
      group; /* borrowed while root retains the graph */
  if (n->kind == SET_V2_GROUP) {
    for (size_t i = 0; i < n->child_count; i++) {
      const struct producer_set_v2_node *child = &n->children[i];
      obs_source_t *source = assemble(p, child, index);
      if (!source) {
        obs_source_release(group);
        return NULL;
      }
      bool ok = producer_set_v2_group_add(group, source, child->x, child->y,
                                          child->width, child->height, false);
      obs_source_release(source);
      if (!ok) {
        fail(p, "Native child attachment failed");
        obs_source_release(group);
        return NULL;
      }
    }
  } else if (!place(group, n->surface, 0, 0, w, h, n->fit)) {
    fail(p, "Native surface attachment failed");
    obs_source_release(group);
    return NULL;
  }
  producer_set_v2_group_seal(group);
  return group;
}
struct producer_set_v2_scene *producer_set_v2_scene_prepare(
    const struct producer_set_v2_node *root, uint32_t width, uint32_t height,
    enum producer_set_v2_fit fit, size_t budget, char *error, size_t capacity) {
  if (error && capacity)
    error[0] = 0;
  struct producer_set_v2_scene *scene = calloc(1, sizeof(*scene));
  if (!scene) {
    if (error && capacity)
      snprintf(error, capacity, "Native owner allocation failed");
    return NULL;
  }
  struct preparation p = {scene, budget, error, capacity};
  if (!budget || budget > BYTE_LIMIT || !fit_valid(fit) || !root ||
      root->kind != SET_V2_GROUP || root->x != 0 || root->y != 0) {
    fail(&p, "Invalid native scene request");
    free(scene);
    return NULL;
  }
  if (!allocation(&p, width, height) || !validate(&p, root, 0)) {
    free(scene);
    return NULL;
  }
  size_t index = 0;
  obs_source_t *design = assemble(&p, root, &index);
  if (!design) {
    free(scene);
    return NULL;
  }
  scene->root = producer_set_v2_group_create(width, height, 0, 1);
  if (!scene->root || !place(scene->root, design, 0, 0, width, height, fit)) {
    fail(&p, "Native viewport allocation/attachment failed");
    obs_source_release(design);
    producer_set_v2_scene_release(scene);
    return NULL;
  }
  obs_source_release(design);
  producer_set_v2_group_seal(scene->root);
  return scene;
}
obs_source_t *producer_set_v2_scene_source(struct producer_set_v2_scene *s) {
  return s ? s->root : NULL;
}
obs_source_t *producer_set_v2_scene_node(struct producer_set_v2_scene *s,
                                         const char *id) {
  if (s && id)
    for (size_t i = 0; i < s->count; i++)
      if (!strcmp(s->nodes[i].id, id))
        return s->nodes[i].group;
  return NULL;
}
size_t producer_set_v2_scene_texture_bytes(struct producer_set_v2_scene *s) {
  return s ? s->bytes : 0;
}
size_t producer_set_v2_scene_group_count(struct producer_set_v2_scene *s) {
  return s ? s->groups : 0;
}
void producer_set_v2_scene_release(struct producer_set_v2_scene *s) {
  if (!s)
    return;
  if (s->root)
    obs_source_release(s->root);
  free(s);
}
