#include "group.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Exported libobs matrix entry points; ABI pinned by engine/obs.lock. */
OBS_IMPORT void gs_matrix_translate3f(float x, float y, float z);
OBS_IMPORT void gs_matrix_scale3f(float x, float y, float z);
OBS_IMPORT void gs_matrix_rotaa4f(float x, float y, float z, float angle);
OBS_IMPORT enum gs_color_space gs_get_color_space(void);
OBS_IMPORT size_t obs_source_filter_count(const obs_source_t *source);

#define GROUP_ID "producer_set_v2_group"
#define GROUP_CHILD_LIMIT 128
#define GROUP_DEPTH_LIMIT 16
/* A single offscreen texture at output-aware density. Aggregate budget belongs to
 * the render-plan owner. Prevent a malformed direct call allocating huge
 * targets. */
#define GROUP_PIXEL_LIMIT (4096u * 4096u)

struct layer {
  obs_source_t *source;
  float x, y, width, height;
  bool contain, visible;
  float rotation, scale_x, scale_y;
};
struct group {
  obs_source_t *source;
  uint32_t width, height;
  float density;
  float radius, opacity;
  struct vec2 viewport_inset;
  gs_texrender_t *texture;
  gs_texrender_t *accum[2], *blur_texture;
  int mask_kind,mask_direction;float mask_progress,mask_x,mask_y,mask_feather,backdrop_blur;bool mask_invert;
  gs_effect_t *effect;
  struct layer layers[GROUP_CHILD_LIMIT];
  size_t count;
  bool sealed;
#ifdef PRODUCER_SET_V2_PROBE
  bool force_isolation;
  struct producer_set_v2_group_probe_stats probe;
#endif
};
static atomic_size_t live_groups = 0;
static _Thread_local unsigned render_depth = 0;
static const char EFFECT[] =
    "uniform float4x4 ViewProj;uniform texture2d image;uniform float2 extent;"
    "uniform float2 viewport_inset;uniform float radius;uniform float opacity;uniform float mask_kind;uniform float mask_progress;"
    "uniform float2 mask_center;uniform float mask_feather;uniform float mask_invert;uniform float mask_direction;"
    "uniform float2 origin;uniform float2 uv_scale;uniform float2 blur_step;"
    "uniform texture2d backdrop_image;uniform float2 backdrop_origin;uniform float2 backdrop_scale;"
    "sampler_state smp{Filter=Linear;AddressU=Clamp;AddressV=Clamp;};"
    "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};"
    "V VS(V v){V o;o.pos=mul(float4(v.pos.xyz,1.0),ViewProj);o.uv=v.uv;return o;}"
    "float maskValue(float2 uv){float2 halfSize=extent*0.5;float r=min(radius,min(halfSize.x,halfSize.y));"
    "float2 q=abs((uv-0.5)*extent)-(halfSize-r);float d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;"
    "float base=mask_kind<0.5&&mask_feather>0.5?smoothstep(0.0,mask_feather,-d):saturate(0.5-d);float m=1.0;float feather=max(mask_feather,0.5);"
    "if(mask_kind>0.5){if(mask_progress<=0.0)m=0.0;else if(mask_progress>=1.0)m=1.0;else{"
    "if(mask_kind<1.5){float2 farCorner=max(mask_center,1.0-mask_center)*extent;"
    "d=length((uv-mask_center)*extent)-length(farCorner)*mask_progress;}"
    "else{float t=uv.x;float len=extent.x;if(mask_direction>2.5){t=1.0-uv.y;len=extent.y;}"
    "else if(mask_direction>1.5){t=uv.y;len=extent.y;}else if(mask_direction>0.5)t=1.0-uv.x;"
    "d=(t-mask_progress)*len;}m=saturate(0.5-d/feather);}}"
    "if(mask_invert>0.5)m=1.0-m;return base*m;}"
    "float4 PS(V v):TARGET{float inside=step(viewport_inset.x,v.uv.x)*step(viewport_inset.y,v.uv.y)*step(v.uv.x,1.0-viewport_inset.x)*step(v.uv.y,1.0-viewport_inset.y);return lerp(float4(0.0,0.0,0.0,opacity),image.Sample(smp,v.uv)*(maskValue(v.uv)*opacity),inside);}"
    "float4 Blur(V v):TARGET{float2 uv=origin+v.uv*uv_scale;"
    "float4 c=image.Sample(smp,uv)*0.227027;"
    "c+=(image.Sample(smp,uv+blur_step*1.384615)+image.Sample(smp,uv-blur_step*1.384615))*0.316216;"
    "c+=(image.Sample(smp,uv+blur_step*3.230769)+image.Sample(smp,uv-blur_step*3.230769))*0.070270;return c;}"
    "float4 BlurMask(V v):TARGET{float4 prior=backdrop_image.Sample(smp,backdrop_origin+v.uv*backdrop_scale);return lerp(prior,Blur(v),maskValue(v.uv)*opacity);}"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}"
    "technique BlurHorizontal{pass{vertex_shader=VS(v);pixel_shader=Blur(v);}}"
    "technique BlurVertical{pass{vertex_shader=VS(v);pixel_shader=BlurMask(v);}}";
/* One libobs graphics device per engine. Rendering and these lease changes
 * hold its graphics context lock. All child rendering finishes before a group
 * sets uniforms/begins its own pass, so the program can be shared while each
 * group's textures, placement and mask parameters remain independent. */
static gs_effect_t *shared_effect;
static size_t effect_leases;
static atomic_size_t effect_compilations;
static gs_effect_t *acquire_effect(char **error) {
  if (!shared_effect) {
    shared_effect=gs_effect_create(EFFECT,"producer-set-v2-group.effect",error);
    if(shared_effect)atomic_fetch_add(&effect_compilations,1);
  }
  if(shared_effect)effect_leases++;
  return shared_effect;
}
static void release_effect(gs_effect_t *effect) {
  if(!effect)return;
  if(effect==shared_effect&&effect_leases&&!--effect_leases){gs_effect_destroy(shared_effect);shared_effect=NULL;}
}
size_t producer_set_v2_group_effect_compilations(void){return atomic_load(&effect_compilations);}
static struct group *get(obs_source_t *s);
static void effect_draw(struct group *g,gs_texture_t *texture,const char *tech,uint32_t w,uint32_t h){
 gs_effect_set_texture(gs_effect_get_param_by_name(g->effect,"image"),texture);
 gs_technique_t *t=gs_effect_get_technique(g->effect,tech);size_t passes=gs_technique_begin(t);
 for(size_t i=0;i<passes;i++)if(gs_technique_begin_pass(t,i)){gs_draw_sprite(texture,0,w,h);gs_technique_end_pass(t);}gs_technique_end(t);
}
static void mask_params(struct group *g,const struct group *mask,float density,float opacity){
 gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"viewport_inset"),&g->viewport_inset);
 struct vec2 extent={mask->width*density,mask->height*density},center={mask->mask_x,mask->mask_y};
 gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"extent"),&extent);
 gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"mask_center"),&center);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"radius"),mask->radius*density);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"opacity"),opacity);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_kind"),(float)mask->mask_kind);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_progress"),mask->mask_progress);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_feather"),mask->mask_feather*density);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_invert"),mask->mask_invert?1:0);
 gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_direction"),(float)mask->mask_direction);
}
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
  g->mask_progress=1;g->mask_x=g->mask_y=.5f;
  g->width = (uint32_t)w;
  g->height = (uint32_t)h;
  g->density = 1;
  g->radius = (float)radius;
  g->opacity = (float)opacity;
  char *error = NULL;
  obs_enter_graphics();
  g->effect = acquire_effect(&error);
  g->texture = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  obs_leave_graphics();
  if (error) {
    blog(LOG_ERROR, "[sets-v2] group effect: %s", error);
    bfree(error);
  }
  if (!g->effect || !g->texture) {
    obs_enter_graphics();
    if (g->effect)
      release_effect(g->effect);
    if (g->texture)
      gs_texrender_destroy(g->texture);
  for(int i=0;i<2;i++)gs_texrender_destroy(g->accum[i]);gs_texrender_destroy(g->blur_texture);
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
  for (size_t i = 0; i < 2; i++)
    gs_texrender_destroy(g->accum[i]);
  gs_texrender_destroy(g->blur_texture);
  release_effect(g->effect);
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
/* Bypass offscreen sampling only when no group isolation or clipping is
 * needed. Check each frame: animation may move a child outside its bounds. */
static bool direct(const struct group *g) {
  if (g->radius != 0 || g->opacity != 1 || g->mask_kind || g->mask_invert || g->viewport_inset.x > 0 || g->viewport_inset.y > 0) return false;
  for (size_t i=0;i<g->count;i++) {
    const struct layer *l=&g->layers[i];
    if (!l->visible) continue;
    const struct group *child=get(l->source);if(child&&child->backdrop_blur>0)return false;
    if (l->rotation != 0 || l->scale_x != 1 || l->scale_y != 1 ||
        l->x < 0 || l->y < 0 || l->x+l->width > g->width ||
        l->y+l->height > g->height) return false;
  }
  return true;
}
/* An unfiltered identity wrapper around our own SDR compositor adds no blend,
 * clip or raster-resolution boundary. Let the deepest required group retain
 * encoded-SDR isolation and decode once. The child's final shader must also be
 * an identity: encoded opacity/masks do not commute with sRGB decoding.
 * Raw/plugin sources and filtered placements keep their intermediate pass. */
static bool identity_group_child(const struct group *g) {
  if (g->count != 1 || g->backdrop_blur != 0 ||
      gs_get_color_space() != GS_CS_SRGB || obs_source_filter_count(g->source))
    return false;
  const struct layer *l = &g->layers[0];
  const struct group *child = get(l->source);
  return l->visible && child && child->sealed &&
         child->radius == 0 && child->opacity == 1 && !child->mask_kind &&
         !child->mask_invert && child->viewport_inset.x == 0 &&
         child->viewport_inset.y == 0 && child->backdrop_blur == 0 &&
         !obs_source_filter_count(l->source) && !l->contain &&
         l->x == 0 && l->y == 0 && l->rotation == 0 &&
         l->scale_x == 1 && l->scale_y == 1 &&
         l->width == g->width && l->height == g->height &&
         child->width == g->width && child->height == g->height &&
         obs_source_get_width(l->source) == g->width &&
         obs_source_get_height(l->source) == g->height &&
         child->density == g->density;
}
static void draw_children_range(struct group *g,size_t from,size_t to) {
  for (size_t i = from; i < to; i++) {
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
    gs_matrix_translate3f(l->width * .5f, l->height * .5f, 0);
    gs_matrix_rotaa4f(0, 0, 1, l->rotation * 0.0174532925199433f);
    gs_matrix_scale3f(l->scale_x, l->scale_y, 1);
    gs_matrix_translate3f(-l->width * .5f, -l->height * .5f, 0);
    gs_matrix_scale3f(sx, sy, 1);
    obs_source_video_render(l->source);
    gs_matrix_pop();
  }
}
/* Explicit local-sibling backdrop. Ping-pong accumulation never samples the
 * active render target. The two blur passes are cropped to the panel. */
static gs_texture_t *draw_backdrops(struct group *g){
 uint32_t w=(uint32_t)ceilf(g->width*g->density),h=(uint32_t)ceilf(g->height*g->density);
 for(int i=0;i<2;i++)if(!g->accum[i])g->accum[i]=gs_texrender_create(GS_RGBA,GS_ZS_NONE);
 if(!g->blur_texture)g->blur_texture=gs_texrender_create(GS_RGBA,GS_ZS_NONE);
 if(!g->accum[0]||!g->accum[1]||!g->blur_texture)return NULL;
 int current=0;size_t start=0;const struct vec4 clear={0,0,0,0};
 gs_texrender_reset(g->accum[0]);if(!gs_texrender_begin(g->accum[0],w,h))return NULL;
 gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,g->width,0,g->height,-100,100);gs_matrix_push();gs_matrix_identity();
 for(size_t i=0;i<g->count;i++){
  const struct layer *l=&g->layers[i];const struct group *child=get(l->source);
  if(!child||child->backdrop_blur<=0||!l->visible||child->opacity<=0)continue;
  draw_children_range(g,start,i);gs_matrix_pop();gs_texrender_end(g->accum[current]);
  gs_texture_t *previous=gs_texrender_get_texture(g->accum[current]);
  uint32_t bw=(uint32_t)ceilf(l->width*g->density),bh=(uint32_t)ceilf(l->height*g->density);
  // A vertical blur needs horizontal samples above and below the panel edge.
  // Blur a padded crop, then sample its center in the second pass.
  uint32_t pad=(uint32_t)ceilf(child->backdrop_blur*g->density),padded=bh+2*pad;
  gs_texrender_reset(g->blur_texture);
  if(!gs_texrender_begin(g->blur_texture,bw,padded))return NULL;
  gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,bw,0,padded,-100,100);gs_matrix_push();gs_matrix_identity();
  struct vec2 origin={l->x/g->width,(l->y-pad/g->density)/g->height},scale={l->width/g->width,(l->height+2*pad/g->density)/g->height},step={child->backdrop_blur*g->density/(3.230769f*w),0};
  gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"origin"),&origin);gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"uv_scale"),&scale);gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"blur_step"),&step);
  effect_draw(g,previous,"BlurHorizontal",bw,padded);gs_matrix_pop();gs_texrender_end(g->blur_texture);
  int next=1-current;gs_texrender_reset(g->accum[next]);if(!gs_texrender_begin(g->accum[next],w,h))return NULL;
  gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,g->width,0,g->height,-100,100);gs_matrix_push();gs_matrix_identity();
  mask_params(g,g,g->density,1);gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_kind"),0);gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_invert"),0);gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"radius"),0);
  effect_draw(g,previous,"Draw",g->width,g->height);
  origin=(struct vec2){0,(float)pad/padded};scale=(struct vec2){1,(float)bh/padded};step=(struct vec2){0,child->backdrop_blur*g->density/(3.230769f*padded)};
  gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"origin"),&origin);gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"uv_scale"),&scale);gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"blur_step"),&step);
  struct vec2 backdrop_origin={l->x/g->width,l->y/g->height},backdrop_scale={l->width/g->width,l->height/g->height};
  gs_effect_set_texture(gs_effect_get_param_by_name(g->effect,"backdrop_image"),previous);
  gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"backdrop_origin"),&backdrop_origin);gs_effect_set_vec2(gs_effect_get_param_by_name(g->effect,"backdrop_scale"),&backdrop_scale);
  mask_params(g,child,g->density,child->opacity);gs_matrix_translate3f(l->x,l->y,0);
  gs_blend_function(GS_BLEND_ONE,GS_BLEND_ZERO);
  effect_draw(g,gs_texrender_get_texture(g->blur_texture),"BlurVertical",(uint32_t)l->width,(uint32_t)l->height);
  gs_blend_function(GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
  gs_matrix_identity();current=next;start=i;
 }
 draw_children_range(g,start,g->count);gs_matrix_pop();gs_texrender_end(g->accum[current]);return gs_texrender_get_texture(g->accum[current]);
}
static void render(void *data, gs_effect_t *unused) {
  (void)unused;
  struct group *g = data;
  if (!g->sealed || render_depth >= GROUP_DEPTH_LIMIT)
    return;
  render_depth++;
  const bool linear=gs_get_linear_srgb();
  const bool framebuffer=gs_framebuffer_srgb_enabled();
  const bool nonlinear = !linear && !framebuffer;
  const bool identity = !nonlinear && direct(g) && identity_group_child(g);
  bool bypass = identity || (nonlinear && direct(g));
#ifdef PRODUCER_SET_V2_PROBE
  bypass = bypass && !g->force_isolation;
#endif
  if (bypass) {
#ifdef PRODUCER_SET_V2_PROBE
    if (identity) g->probe.identity_bypasses++;
    else g->probe.nonlinear_bypasses++;
#endif
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
    draw_children_range(g,0,g->count);
    gs_blend_state_pop();
    render_depth--;
    return;
  }
  // Intermediate surfaces store encoded SDR pixels. Children render in that
  // explicit context; the final texture is decoded once for a linear parent.
  gs_set_linear_srgb(false);
  gs_enable_framebuffer_srgb(false);
  bool backdrop=false;for(size_t i=0;i<g->count;i++){const struct group *child=get(g->layers[i].source);if(child&&child->backdrop_blur>0)backdrop=true;}
  gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
  gs_texture_t *composed=backdrop?draw_backdrops(g):NULL;
  gs_blend_state_pop();
  gs_texrender_reset(g->texture);
  if (gs_texrender_begin(g->texture, (uint32_t)ceilf(g->width*g->density), (uint32_t)ceilf(g->height*g->density))) {
#ifdef PRODUCER_SET_V2_PROBE
    g->probe.intermediate_passes++;
#endif
    const struct vec4 clear = {0, 0, 0, 0};
    gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
    gs_ortho(0, (float)g->width, 0, (float)g->height, -100, 100);
    gs_matrix_push();
    gs_matrix_identity();
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
    if(composed){mask_params(g,g,g->density,1);gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_kind"),0);gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"mask_invert"),0);gs_effect_set_float(gs_effect_get_param_by_name(g->effect,"radius"),0);effect_draw(g,composed,"Draw",g->width,g->height);}
    else draw_children_range(g,0,g->count);
    gs_blend_state_pop();
    gs_matrix_pop();
    gs_texrender_end(g->texture);
    gs_texture_t *texture = gs_texrender_get_texture(g->texture);
    gs_set_linear_srgb(linear);
    gs_enable_framebuffer_srgb(linear);
    if(linear)gs_effect_set_texture_srgb(gs_effect_get_param_by_name(g->effect,"image"),texture);
    else gs_effect_set_texture(gs_effect_get_param_by_name(g->effect,"image"),texture);
    mask_params(g,g,g->density,g->opacity);
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
  gs_enable_framebuffer_srgb(framebuffer);
  gs_set_linear_srgb(linear);
  render_depth--;
}
void producer_set_v2_register(void) {
  struct obs_source_info info;
  memset(&info, 0, sizeof(info));
  info.id = GROUP_ID;
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
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
bool producer_set_v2_group_density(obs_source_t *s, float density) {
  struct group *g=get(s);
  if (!g || g->sealed || !isfinite(density) || density < 1 || density > 8)
    return false;
  double w=ceil(g->width*density),h=ceil(g->height*density);
  if (w > 8192 || h > 8192 || w*h > GROUP_PIXEL_LIMIT) return false;
  g->density=density;
  return true;
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
  g->layers[g->count++] =
      (struct layer){ref, x, y, w, h, contain, true, 0, 1, 1};
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
#ifdef PRODUCER_SET_V2_PROBE
/* Probe-only controls; callers hold the graphics context. Absent from shipped
 * builds, so frame counters and forced-reference state add no runtime work. */
void producer_set_v2_group_probe_reset(obs_source_t *source) {
  struct group *g = get(source);
  if (g) g->probe = (struct producer_set_v2_group_probe_stats){0};
}
struct producer_set_v2_group_probe_stats producer_set_v2_group_probe_stats(obs_source_t *source) {
  struct group *g = get(source);
  return g ? g->probe : (struct producer_set_v2_group_probe_stats){0};
}
void producer_set_v2_group_probe_force_isolation(obs_source_t *source, bool force) {
  struct group *g = get(source);
  if (g) g->force_isolation = force;
}
#endif
bool producer_set_v2_group_layer_transform(obs_source_t *s, size_t index,
                                           float rotation, float sx, float sy) {
  struct group *g = get(s);
  if (!g || index >= g->count || !isfinite(rotation) ||
      fabsf(rotation) > 36000 || !isfinite(sx) || !isfinite(sy) || sx < .01f ||
      sy < .01f || sx > 32 || sy > 32)
    return false;
  g->layers[index].rotation = rotation;
  g->layers[index].scale_x = sx;
  g->layers[index].scale_y = sy;
  return true;
}
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

bool producer_set_v2_group_effects(obs_source_t *source,int kind,float progress,float x,float y,float feather,bool invert,int direction,float blur){
 struct group *g=get(source);if(!g||g->sealed||kind<0||kind>2||!isfinite(progress)||progress<0||progress>1||!isfinite(x)||x<0||x>1||!isfinite(y)||y<0||y>1||!isfinite(feather)||feather<0||feather>32||direction<0||direction>3||!isfinite(blur)||blur<0||blur>24)return false;
 g->mask_kind=kind;g->mask_progress=progress;g->mask_x=x;g->mask_y=y;g->mask_feather=feather;g->mask_invert=invert;g->mask_direction=direction;g->backdrop_blur=blur;return true;
}
bool producer_set_v2_group_mask_progress(obs_source_t *source,float progress){struct group *g=get(source);if(!g||!isfinite(progress)||progress<0||progress>1)return false;g->mask_progress=progress;return true;}

/* Only the output viewport owns letterbox bars. Preserve authored alpha inside. */
bool producer_set_v2_group_viewport_inset(obs_source_t *source,float x,float y) {
 struct group *g=get(source);
 if(!g||g->sealed||!isfinite(x)||!isfinite(y)||x<0||y<0||x>=.5f||y>=.5f)return false;
 g->viewport_inset=(struct vec2){x,y};return true;
}
