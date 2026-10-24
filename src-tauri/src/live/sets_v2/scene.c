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
  obs_source_t *parent;
  size_t index;
  float x, y, width, height, radius, opacity, rotation, sx, sy;
  bool visible;
};
struct producer_set_v2_scene {
  obs_source_t *root;
  struct owned_node nodes[NODE_LIMIT], initial[NODE_LIMIT];
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
  if (!isfinite(n->rotation) || fabsf(n->rotation) > 36000 ||
      !isfinite(n->scale_x) || !isfinite(n->scale_y) || n->scale_x < 0 ||
      n->scale_y < 0 || n->scale_x > 32 || n->scale_y > 32)
    return fail(p, "Invalid native placement transform");
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
  struct owned_node *entry = &p->scene->nodes[own];
  entry->x = n->x;
  entry->y = n->y;
  entry->width = n->width;
  entry->height = n->height;
  entry->radius = n->radius;
  entry->opacity = n->opacity;
  entry->visible = n->visible;
  entry->rotation = n->rotation;
  entry->sx = n->scale_x == 0 ? 1 : n->scale_x;
  entry->sy = n->scale_y == 0 ? 1 : n->scale_y;
  if (n->kind == SET_V2_GROUP) {
    for (size_t i = 0; i < n->child_count; i++) {
      const struct producer_set_v2_node *child = &n->children[i];
      size_t child_index = *index;
      obs_source_t *source = assemble(p, child, index);
      if (!source) {
        obs_source_release(group);
        return NULL;
      }
      bool ok = producer_set_v2_group_add(group, source, child->x, child->y,
                                          child->width, child->height, false);
      if (ok)
        ok = producer_set_v2_group_layer_transform(
            group, i, child->rotation, child->scale_x == 0 ? 1 : child->scale_x,
            child->scale_y == 0 ? 1 : child->scale_y);
      obs_source_release(source);
      p->scene->nodes[child_index].parent = group;
      p->scene->nodes[child_index].index = i;
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
  memcpy(scene->initial, scene->nodes, sizeof(scene->nodes));
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
bool producer_set_v2_scene_frame(struct producer_set_v2_scene *s,
                                 const char *id, int property, float value) {
  if (!s || !id || !isfinite(value))
    return false;
  struct owned_node *n = NULL;
  for (size_t i = 0; i < s->count; i++)
    if (!strcmp(s->nodes[i].id, id)) {
      n = &s->nodes[i];
      break;
    }
  if (!n)
    return false;
  if (property == 4) {
    if (value < 0 || value > 1)
      return false;
    n->opacity = value;
    return producer_set_v2_group_frame(n->group, n->radius,
                                       n->visible ? value : 0);
  }
  if (!n->parent)
    return false;
  if (property <= 1) {
    if (fabsf(value) > 16384)
      return false;
    if (property == 0)
      n->x = value;
    else
      n->y = value;
  } else if (property <= 3) {
    if (value < 0 || value > 8192)
      return false;
    if (property == 2)
      n->width = value;
    else
      n->height = value;
  } else if (property == 5) {
    if (fabsf(value) > 36000)
      return false;
    n->rotation = value;
  } else if (property == 6) {
    if (value < .01f || value > 32)
      return false;
    n->sx = value;
    n->sy = value;
  } else
    return false;
  if (!producer_set_v2_group_layer_frame(
          n->parent, n->index, n->x, n->y, fmaxf(1, n->width),
          fmaxf(1, n->height), n->visible && n->width > 0 && n->height > 0))
    return false;
  return producer_set_v2_group_layer_transform(n->parent, n->index, n->rotation,
                                               n->sx, n->sy);
}

void producer_set_v2_scene_reset(struct producer_set_v2_scene *s) {
  if(!s)return;
  obs_enter_graphics();
  for(size_t i=0;i<s->count;i++){
    struct owned_node n=s->initial[i];
    producer_set_v2_scene_frame(s,n.id,4,n.opacity);
    if(n.parent){
      producer_set_v2_scene_frame(s,n.id,0,n.x);producer_set_v2_scene_frame(s,n.id,1,n.y);
      producer_set_v2_scene_frame(s,n.id,2,n.width);producer_set_v2_scene_frame(s,n.id,3,n.height);
      producer_set_v2_scene_frame(s,n.id,5,n.rotation);producer_set_v2_scene_frame(s,n.id,6,n.sx);
      s->nodes[i].sy=n.sy;producer_set_v2_group_layer_transform(n.parent,n.index,n.rotation,n.sx,n.sy);
    }
  }
  obs_leave_graphics();
}
