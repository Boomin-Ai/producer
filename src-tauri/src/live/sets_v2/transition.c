#include "transition.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ID "producer_set_v2_transition"
struct transition {
  obs_source_t *source, *from, *to;
  gs_texrender_t *a, *b;
  gs_effect_t *effect;
  uint32_t width, height;
  float progress;
  enum producer_set_v2_transition_mode mode;
};
static atomic_size_t live = 0;
static const char CODE[] =
    "uniform float4x4 ViewProj;uniform texture2d previousImage;uniform "
    "texture2d nextImage;uniform float progress;uniform float mode;uniform "
    "float2 extent;"
    "sampler_state smp{Filter=Linear;AddressU=Clamp;AddressV=Clamp;};struct "
    "V{float4 pos:POSITION;float2 uv:TEXCOORD0;};"
    "V VS(V v){V o;o.pos=mul(float4(v.pos.xyz,1),ViewProj);o.uv=v.uv;return o;}"
    /* Branchless masks also avoid scalar-comparison rewriting bugs in the
     * pinned Metal effect translator. Input endpoints remain exact at p=0 and
     * p=1. */
    "float4 PS(V v):TARGET{float p=saturate(progress);float4 "
    "a=previousImage.Sample(smp,v.uv);float4 b=nextImage.Sample(smp,v.uv);"
    "float edge=1.0/extent.x;float "
    "m=1.0-smoothstep(p-edge,p+edge,v.uv.x);m=m*step(0.000001,p);m=max(m,step("
    "0.999999,p));"
    "float2 oldUV=float2(v.uv.x+p,v.uv.y);float2 "
    "newUV=float2(v.uv.x-(1.0-p),v.uv.y);"
    "float4 slideA=previousImage.Sample(smp,oldUV);float4 "
    "slideB=nextImage.Sample(smp,newUV);"
    "float d=1.0-step(0.5,mode);float "
    "w=step(0.5,mode)*(1.0-step(1.5,mode));float s=step(1.5,mode);"
    "return "
    "lerp(a,b,p)*d+lerp(a,b,m)*w+lerp(slideA,slideB,step(1.0,oldUV.x))*s;}"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}";
static const char *name(void *p) {
  (void)p;
  return "Producer set v2 live transition";
}
static uint32_t width(void *p) { return ((struct transition *)p)->width; }
static uint32_t height(void *p) { return ((struct transition *)p)->height; }
static void *create(obs_data_t *d, obs_source_t *s) {
  double w = obs_data_get_double(d, "width"),
         h = obs_data_get_double(d, "height"),
         mode = obs_data_get_double(d, "mode");
  if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > 8192 || h > 8192 ||
      floor(w) != w || floor(h) != h || w * h > 4096u * 4096u || mode < 0 ||
      mode > 2 || floor(mode) != mode)
    return NULL;
  struct transition *t = calloc(1, sizeof(*t));
  if (!t)
    return NULL;
  t->source = s;
  t->width = w;
  t->height = h;
  t->mode = (int)mode;
  char *error = NULL;
  obs_enter_graphics();
  t->a = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  t->b = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  t->effect =
      gs_effect_create(CODE, "producer-set-v2-transition.effect", &error);
  obs_leave_graphics();
  if (error) {
    blog(LOG_ERROR, "[sets-v2] transition: %s", error);
    bfree(error);
  }
  if (!t->a || !t->b || !t->effect) {
    obs_enter_graphics();
    if (t->a)
      gs_texrender_destroy(t->a);
    if (t->b)
      gs_texrender_destroy(t->b);
    if (t->effect)
      gs_effect_destroy(t->effect);
    obs_leave_graphics();
    free(t);
    return NULL;
  }
  atomic_fetch_add(&live, 1);
  return t;
}
static void destroy(void *p) {
  struct transition *t = p;
  if (!t)
    return;
  if (t->from) {
    obs_source_remove_active_child(t->source, t->from);
    obs_source_release(t->from);
  }
  if (t->to) {
    obs_source_remove_active_child(t->source, t->to);
    obs_source_release(t->to);
  }
  obs_enter_graphics();
  gs_texrender_destroy(t->a);
  gs_texrender_destroy(t->b);
  gs_effect_destroy(t->effect);
  obs_leave_graphics();
  atomic_fetch_sub(&live, 1);
  free(t);
}
static void children(void *p, void *callback, void *param) {
  struct transition *t = p;
  void (*cb)(obs_source_t *, obs_source_t *, void *) = callback;
  if (t->from)
    cb(t->source, t->from, param);
  if (t->to)
    cb(t->source, t->to, param);
}
static bool input_frame(struct transition *t, gs_texrender_t *target,
                        obs_source_t *source) {
  uint32_t w = obs_source_get_width(source), h = obs_source_get_height(source);
  if (!w || !h)
    return false;
  gs_texrender_reset(target);
  if (!gs_texrender_begin(target, t->width, t->height))
    return false;
  struct vec4 clear = {0, 0, 0, 0};
  gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
  gs_ortho(0, w, 0, h, -100, 100);
  gs_matrix_push();
  gs_matrix_identity();
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  obs_source_video_render(source);
  gs_blend_state_pop();
  gs_matrix_pop();
  gs_texrender_end(target);
  return true;
}
static void render(void *p, gs_effect_t *unused) {
  (void)unused;
  struct transition *t = p;
  if (!t->from || !t->to || !input_frame(t, t->a, t->from) ||
      !input_frame(t, t->b, t->to))
    return;
  gs_effect_set_texture(gs_effect_get_param_by_name(t->effect, "previousImage"),
                        gs_texrender_get_texture(t->a));
  gs_effect_set_texture(gs_effect_get_param_by_name(t->effect, "nextImage"),
                        gs_texrender_get_texture(t->b));
  gs_effect_set_float(gs_effect_get_param_by_name(t->effect, "progress"),
                      t->progress);
  gs_effect_set_float(gs_effect_get_param_by_name(t->effect, "mode"), t->mode);
  struct vec2 extent = {(float)t->width, (float)t->height};
  gs_effect_set_vec2(gs_effect_get_param_by_name(t->effect, "extent"), &extent);
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  gs_technique_t *tech = gs_effect_get_technique(t->effect, "Draw");
  size_t n = gs_technique_begin(tech);
  for (size_t i = 0; i < n; i++)
    if (gs_technique_begin_pass(tech, i)) {
      gs_draw_sprite(gs_texrender_get_texture(t->a), 0, t->width, t->height);
      gs_technique_end_pass(tech);
    }
  gs_technique_end(tech);
  gs_blend_state_pop();
}
void producer_set_v2_transition_register(void) {
  struct obs_source_info i = {0};
  i.id = ID;
  i.type = OBS_SOURCE_TYPE_INPUT;
  i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  i.get_name = name;
  i.create = create;
  i.destroy = destroy;
  i.get_width = width;
  i.get_height = height;
  i.video_render = render;
  i.enum_active_sources = children;
  i.enum_all_sources = children;
  obs_register_source_s(&i, sizeof(i));
}
obs_source_t *
producer_set_v2_transition_create(obs_source_t *from, obs_source_t *to,
                                  uint32_t w, uint32_t h,
                                  enum producer_set_v2_transition_mode mode) {
  if (!from || !to || !(obs_source_get_output_flags(from) & OBS_SOURCE_VIDEO) ||
      !(obs_source_get_output_flags(to) & OBS_SOURCE_VIDEO) || mode < 0 ||
      mode > 2)
    return NULL;
  char json[160];
  snprintf(json, sizeof(json), "{\"width\":%u,\"height\":%u,\"mode\":%d}", w, h,
           mode);
  obs_data_t *d = obs_data_create_from_json(json);
  obs_source_t *s = obs_source_create_private(ID, "Set v2 live transition", d);
  obs_data_release(d);
  if (!s)
    return NULL;
  struct transition *t = obs_obj_get_data(s);
  if (!t) {
    obs_source_release(s);
    return NULL;
  }
  if (!obs_source_add_active_child(s, from)) {
    obs_source_release(s);
    return NULL;
  }
  t->from = obs_source_get_ref(from);
  if (!obs_source_add_active_child(s, to)) {
    obs_source_release(s);
    return NULL;
  }
  t->to = obs_source_get_ref(to);
  return s;
}
bool producer_set_v2_transition_frame(obs_source_t *s, float progress) {
  if (!s || strcmp(obs_source_get_id(s), ID) || !isfinite(progress) ||
      progress < 0 || progress > 1)
    return false;
  struct transition *t = obs_obj_get_data(s);
  if (!t)
    return false;
  t->progress = progress;
  return true;
}
size_t producer_set_v2_live_transitions(void) { return atomic_load(&live); }
