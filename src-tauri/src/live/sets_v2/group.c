#include "group.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Exported libobs matrix entry points; ABI pinned by engine/obs.lock. */
OBS_IMPORT void gs_matrix_translate3f(float x, float y, float z);
OBS_IMPORT void gs_matrix_scale3f(float x, float y, float z);

#define GROUP_ID "producer_set_v2_group"
#define GROUP_CHILD_LIMIT 128
#define GROUP_DEPTH_LIMIT 16
/* A single offscreen texture at design resolution. Aggregate budget belongs to
 * the render-plan owner. Prevent a malformed direct call allocating huge
 * targets. */
#define GROUP_PIXEL_LIMIT (4096u * 4096u)

struct layer {
  obs_source_t *source;
  float x, y, width, height;
  bool contain, visible;
};
struct group {
  obs_source_t *source;
  uint32_t width, height;
  float radius, opacity;
  gs_texrender_t *texture;
  gs_effect_t *effect;
  struct layer layers[GROUP_CHILD_LIMIT];
  size_t count;
  bool sealed;
};
static atomic_size_t live_groups = 0;
static _Thread_local unsigned render_depth = 0;
static const char EFFECT[] =
    "uniform float4x4 ViewProj;uniform texture2d image;uniform float2 "
    "extent;uniform float radius;uniform float opacity;\n"
    "sampler_state smp{Filter=Linear;AddressU=Clamp;AddressV=Clamp;};\n"
    "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};\n"
    "V VS(V v){V o;o.pos=mul(float4(v.pos.xyz,1.0),ViewProj);o.uv=v.uv;return "
    "o;}\n"
    "float4 PS(V v):TARGET{float2 halfSize=extent*0.5;float "
    "r=min(radius,min(halfSize.x,halfSize.y));"
    "float2 q=abs((v.uv-0.5)*extent)-(halfSize-r);float "
    "d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;"
    "float mask=saturate(0.5-d);return "
    "image.Sample(smp,v.uv)*(mask*opacity);}\n"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}\n";
static const char *name(void *unused) {
  (void)unused;
  return "Producer set v2 ordered group";
}
static uint32_t width(void *data) { return ((struct group *)data)->width; }
static uint32_t height(void *data) { return ((struct group *)data)->height; }
static void *create(obs_data_t *settings, obs_source_t *source) {
  double w = obs_data_get_double(settings, "width"),
         h = obs_data_get_double(settings, "height");
  double radius = obs_data_get_double(settings, "radius"),
         opacity = obs_data_get_double(settings, "opacity");
  if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > 8192 || h > 8192 ||
      floor(w) != w || floor(h) != h || w * h > GROUP_PIXEL_LIMIT ||
      !isfinite(radius) || radius < 0 || radius > 8192 || !isfinite(opacity) ||
      opacity < 0 || opacity > 1)
    return NULL;
  struct group *g = calloc(1, sizeof(*g));
  if (!g)
    return NULL;
  g->source = source;
  g->width = (uint32_t)w;
  g->height = (uint32_t)h;
  g->radius = (float)radius;
  g->opacity = (float)opacity;
  char *error = NULL;
  obs_enter_graphics();
  g->effect = gs_effect_create(EFFECT, "producer-set-v2-group.effect", &error);
  g->texture = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  obs_leave_graphics();
  if (error) {
    blog(LOG_ERROR, "[sets-v2] group effect: %s", error);
    bfree(error);
  }
  if (!g->effect || !g->texture) {
    obs_enter_graphics();
    if (g->effect)
      gs_effect_destroy(g->effect);
    if (g->texture)
      gs_texrender_destroy(g->texture);
    obs_leave_graphics();
    free(g);
    return NULL;
  }
  atomic_fetch_add(&live_groups, 1);
  return g;
}
static void destroy(void *data) {
  struct group *g = data;
  if (!g)
    return;
  for (size_t i = 0; i < g->count; i++) {
    obs_source_remove_active_child(g->source, g->layers[i].source);
    obs_source_release(g->layers[i].source);
  }
  obs_enter_graphics();
  gs_texrender_destroy(g->texture);
  gs_effect_destroy(g->effect);
  obs_leave_graphics();
  atomic_fetch_sub(&live_groups, 1);
  free(g);
}
static void children(void *data, void *callback, void *param) {
  struct group *g = data;
  for (size_t i = 0; i < g->count; i++)
    ((void (*)(obs_source_t *, obs_source_t *, void *))callback)(
        g->source, g->layers[i].source, param);
}
static void render(void *data, gs_effect_t *unused) {
  (void)unused;
  struct group *g = data;
  if (!g->sealed || render_depth >= GROUP_DEPTH_LIMIT)
    return;
  render_depth++;
  gs_texrender_reset(g->texture);
  if (gs_texrender_begin(g->texture, g->width, g->height)) {
    const struct vec4 clear = {0, 0, 0, 0};
    gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
    gs_ortho(0, (float)g->width, 0, (float)g->height, -100, 100);
    gs_matrix_push();
    gs_matrix_identity();
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
    for (size_t i = 0; i < g->count; i++) {
      const struct layer *l = &g->layers[i];
      if (!l->visible)
        continue;
      uint32_t sw = obs_source_get_width(l->source),
               sh = obs_source_get_height(l->source);
      if (!sw || !sh)
        continue;
      float sx = l->width / sw, sy = l->height / sh, dx = l->x, dy = l->y;
      if (l->contain) {
        float s = fminf(sx, sy);
        dx += (l->width - sw * s) * .5f;
        dy += (l->height - sh * s) * .5f;
        sx = sy = s;
      }
      gs_matrix_push();
      gs_matrix_translate3f(dx, dy, 0);
      gs_matrix_scale3f(sx, sy, 1);
      obs_source_video_render(l->source);
      gs_matrix_pop();
    }
    gs_blend_state_pop();
    gs_matrix_pop();
    gs_texrender_end(g->texture);
    gs_texture_t *texture = gs_texrender_get_texture(g->texture);
    gs_effect_set_texture(gs_effect_get_param_by_name(g->effect, "image"),
                          texture);
    struct vec2 extent = {(float)g->width, (float)g->height};
    gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect, "extent"),
                       &extent);
    gs_effect_set_float(gs_effect_get_param_by_name(g->effect, "radius"),
                        g->radius);
    gs_effect_set_float(gs_effect_get_param_by_name(g->effect, "opacity"),
                        g->opacity);
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
    gs_technique_t *t = gs_effect_get_technique(g->effect, "Draw");
    size_t passes = gs_technique_begin(t);
    for (size_t i = 0; i < passes; i++)
      if (gs_technique_begin_pass(t, i)) {
        gs_draw_sprite(texture, 0, g->width, g->height);
        gs_technique_end_pass(t);
      }
    gs_technique_end(t);
    gs_blend_state_pop();
  }
  render_depth--;
}
void producer_set_v2_register(void) {
  struct obs_source_info info;
  memset(&info, 0, sizeof(info));
  info.id = GROUP_ID;
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  info.get_name = name;
  info.create = create;
  info.destroy = destroy;
  info.get_width = width;
  info.get_height = height;
  info.video_render = render;
  info.enum_active_sources = children;
  info.enum_all_sources = children;
  obs_register_source_s(&info, sizeof(info));
}
static struct group *get(obs_source_t *s) {
  return s && strcmp(obs_source_get_id(s), GROUP_ID) == 0 ? obs_obj_get_data(s)
                                                          : NULL;
}
obs_source_t *producer_set_v2_group_create(uint32_t w, uint32_t h, float radius,
                                           float opacity) {
  char json[200];
  snprintf(json, sizeof(json),
           "{\"width\":%u,\"height\":%u,\"radius\":%.9g,\"opacity\":%.9g}", w,
           h, radius, opacity);
  obs_data_t *d = obs_data_create_from_json(json);
  if (!d)
    return NULL;
  obs_source_t *s = obs_source_create_private(GROUP_ID, "Set v2 group", d);
  obs_data_release(d);
  if (s && !get(s)) {
    obs_source_release(s);
    return NULL;
  }
  return s;
}
bool producer_set_v2_group_add(obs_source_t *s, obs_source_t *child, float x,
                               float y, float w, float h, bool contain) {
  struct group *g = get(s);
  if (!g || g->sealed || !child || child == s ||
      !(obs_source_get_output_flags(child) & OBS_SOURCE_VIDEO) ||
      g->count >= GROUP_CHILD_LIMIT || !isfinite(x) || !isfinite(y) ||
      !isfinite(w) || !isfinite(h) || fabsf(x) > 16384 || fabsf(y) > 16384 ||
      w <= 0 || h <= 0 || w > 16384 || h > 16384)
    return false;
  /* libobs rejects cyclic active-child references. No imported package can bind
   * a source pointer. */
  if (!obs_source_add_active_child(s, child))
    return false;
  obs_source_t *ref = obs_source_get_ref(child);
  if (!ref) {
    obs_source_remove_active_child(s, child);
    return false;
  }
  g->layers[g->count++] = (struct layer){ref, x, y, w, h, contain, true};
  return true;
}
bool producer_set_v2_group_seal(obs_source_t *s) {
  struct group *g = get(s);
  if (!g)
    return false;
  g->sealed = true;
  return true;
}
bool producer_set_v2_group_frame(obs_source_t *s, float radius, float opacity) {
  struct group *g = get(s);
  if (!g || !isfinite(radius) || radius < 0 || radius > 8192 ||
      !isfinite(opacity) || opacity < 0 || opacity > 1)
    return false;
  g->radius = radius;
  g->opacity = opacity;
  return true;
}
size_t producer_set_v2_live_groups(void) { return atomic_load(&live_groups); }
bool producer_set_v2_group_layer_frame(obs_source_t *s, size_t index, float x,
                                       float y, float w, float h,
                                       bool visible) {
  struct group *g = get(s);
  if (!g || !g->sealed || index >= g->count || !isfinite(x) || !isfinite(y) ||
      !isfinite(w) || !isfinite(h) || fabsf(x) > 16384 || fabsf(y) > 16384 ||
      w <= 0 || h <= 0 || w > 16384 || h > 16384)
    return false;
  struct layer *l = &g->layers[index];
  l->x = x;
  l->y = y;
  l->width = w;
  l->height = h;
  l->visible = visible;
  return true;
}
