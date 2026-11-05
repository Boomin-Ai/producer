#include "raster.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

OBS_IMPORT void gs_matrix_translate3f(float, float, float);
OBS_IMPORT void *gs_get_context(void);
OBS_IMPORT bool obs_in_task_thread(int);
OBS_IMPORT void obs_queue_task(int, void (*)(void *), void *, bool);
OBS_IMPORT size_t obs_source_filter_count(const obs_source_t *);
OBS_IMPORT void obs_source_inc_active(obs_source_t *);
OBS_IMPORT void obs_source_dec_active(obs_source_t *);
OBS_IMPORT void obs_source_inc_showing(obs_source_t *);
OBS_IMPORT void obs_source_dec_showing(obs_source_t *);
OBS_IMPORT uint64_t os_gettime_ns(void);

#define RASTER_ID "producer_set_v2_raster"
#define RASTER_PIXEL_LIMIT (4096u * 4096u)
struct raster {
  uint32_t width, height, physical_width, physical_height;
  uint32_t target_width, target_height;
  float density;
  gs_texrender_t *target;
  gs_effect_t *effect;
  atomic_bool ready;
  atomic_size_t resident_bytes;
  uint8_t marker[18];
  struct producer_set_v2_raster_creation_stats creation;
  atomic_bool creation_pending;
#ifdef PRODUCER_SET_V2_PROBE
  bool input_observed;
#endif
};
/* A driver copy with unprovable completion must not free a backing CEF image.
 * There can be only one such retained transaction: graphics tasks serialize,
 * and the first terminal failure disables all later copies before input reads.
 * These references and active/showing leases deliberately last until exit. */
static atomic_bool captures_disabled;
static atomic_size_t quarantine_count;
static obs_source_t *quarantined_snapshot, *quarantined_input;
static gs_stagesurf_t *quarantined_stage;
static uint8_t quarantined_nonce[18];
static uint64_t process_seed, next_marker = 1, next_nonce = 1;
static void fence_bytes(uint8_t out[18], uint64_t serial, uint16_t tag) {
  for (int i = 0; i < 8; i++) {
    out[i] = (uint8_t)(process_seed >> (i * 8));
    out[8 + i] = (uint8_t)(serial >> (i * 8));
  }
  uint16_t check = tag;
  for (int i = 0; i < 16; i++) check = (uint16_t)((check * 257u) ^ out[i]);
  out[16] = (uint8_t)check; out[17] = (uint8_t)(check >> 8);
}
/* Same device-scoped lease discipline as the existing Set group compositor.
 * Only creation/destruction under its graphics context changes this pool. */
static gs_effect_t *shared_effect;
static size_t effect_leases;
static const char EFFECT[] =
    "uniform float4x4 ViewProj;uniform texture2d image;uniform float2 uv_scale;"
    "uniform float2 uv_min;uniform float2 uv_max;uniform float2 extent;uniform float4 solid;"
    "sampler_state smp{Filter=Linear;AddressU=Clamp;AddressV=Clamp;};"
    "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};"
    "V VS(V v){V o;o.pos=mul(float4(v.pos.xyz,1.0),ViewProj);o.uv=v.uv;return o;}"
    "float4 PS(V v):TARGET{float2 q=abs((v.uv-0.5)*extent)-extent*0.5;"
    "float d=length(max(q,0.0))+min(max(q.x,q.y),0.0);"
    "return image.Sample(smp,clamp(v.uv*uv_scale,uv_min,uv_max))*saturate(0.5-d);}"
    "float4 Solid(V v):TARGET{return solid;}"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}"
    "technique Nonce{pass{vertex_shader=VS(v);pixel_shader=Solid(v);}}";
static gs_effect_t *acquire_effect(struct producer_set_v2_raster_creation_stats *stats) {
  if (!shared_effect) {
    char *error = NULL;
    stats->effect_compiled = 1;
    stats->effect_compile_offset_ns = os_gettime_ns();
    shared_effect = gs_effect_create(EFFECT, "producer-set-v2-raster.effect", &error);
    stats->effect_compile_ns = os_gettime_ns() - stats->effect_compile_offset_ns;
    if (error) bfree(error); /* No arbitrary compiler text enters diagnostics. */
  }
  if (shared_effect) effect_leases++;
  return shared_effect;
}
static void release_effect(gs_effect_t *effect) {
  if (effect && effect == shared_effect && effect_leases && !--effect_leases) {
    gs_effect_destroy(shared_effect);
    shared_effect = NULL;
  }
}
static struct raster *get(obs_source_t *source) {
  return source && !strcmp(obs_source_get_id(source), RASTER_ID)
             ? obs_obj_get_data(source) : NULL;
}
static bool relative_phase(uint64_t start, uint64_t end, uint64_t *offset,
                           uint64_t duration) {
  if (*offset < start || *offset > end || duration > end - *offset)
    return false;
  *offset -= start;
  return true;
}
static bool finish_creation_stats(struct producer_set_v2_raster_creation_stats *stats,
                                  uint64_t outer_start, uint64_t outer_end) {
  if (outer_end < outer_start || stats->effect_compiled > 1) return false;
  struct producer_set_v2_raster_creation_stats relative = *stats;
  if (!relative_phase(outer_start, outer_end, &relative.graphics_wait_offset_ns,
                      relative.graphics_wait_ns) ||
      !relative_phase(outer_start, outer_end, &relative.texrender_create_offset_ns,
                      relative.texrender_create_ns) ||
      (relative.effect_compiled &&
       !relative_phase(outer_start, outer_end, &relative.effect_compile_offset_ns,
                       relative.effect_compile_ns)) ||
      (!relative.effect_compiled &&
       (relative.effect_compile_offset_ns || relative.effect_compile_ns)))
    return false;
  relative.elapsed_ns = outer_end - outer_start;
  *stats = relative;
  return true;
}
static bool dimensions(double w, double h, double density,
                       uint32_t *pw, uint32_t *ph) {
  if (!isfinite(w) || !isfinite(h) || !isfinite(density) ||
      w < 1 || h < 1 || w > 8192 || h > 8192 ||
      floor(w) != w || floor(h) != h || density < 1 || density > 8)
    return false;
  /* Match the Rust painter's f32 multiplication before ceil, including near
   * integer results such as 10*1.1f. JSON parsing itself uses double. */
  double x = ceil((float)w * (float)density), y = ceil((float)h * (float)density);
  if (x > 8192 || y >= 8192 || fmax(x, 12) * (y + 1) > RASTER_PIXEL_LIMIT)
    return false;
  *pw = (uint32_t)x; *ph = (uint32_t)y;
  return true;
}
static const char *name(void *unused) { (void)unused; return "Immutable Set graphics"; }
static uint32_t width(void *data) { return ((struct raster *)data)->width; }
static uint32_t height(void *data) { return ((struct raster *)data)->height; }
static void *create(obs_data_t *settings, obs_source_t *source) {
  (void)source;
  double w = obs_data_get_double(settings, "width"),
         h = obs_data_get_double(settings, "height"),
         density = obs_data_get_double(settings, "density");
  uint32_t pw, ph;
  if (!dimensions(w, h, density, &pw, &ph)) return NULL;
  struct raster *r = calloc(1, sizeof(*r));
  if (!r) return NULL;
  r->width = (uint32_t)w; r->height = (uint32_t)h;
  r->physical_width = pw; r->physical_height = ph;
  r->target_width = pw < 12 ? 12 : pw; r->target_height = ph + 1;
  r->density = (float)density;
  atomic_init(&r->ready, false); atomic_init(&r->resident_bytes, 0);
  atomic_init(&r->creation_pending, false);
  /* Callback phases store absolute timestamps temporarily. The outer C entry
   * below rebases all of them only after private-source initialization ends. */
  r->creation.graphics_wait_offset_ns = os_gettime_ns();
  obs_enter_graphics();
  r->creation.graphics_wait_ns = os_gettime_ns() - r->creation.graphics_wait_offset_ns;
  if (!process_seed) process_seed = os_gettime_ns();
  if (!process_seed || next_marker == UINT64_MAX || atomic_load(&captures_disabled)) {
    obs_leave_graphics(); free(r); return NULL;
  }
  fence_bytes(r->marker, next_marker++, 0xa55a);
  r->effect = acquire_effect(&r->creation);
  r->creation.texrender_create_offset_ns = os_gettime_ns();
  r->target = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  r->creation.texrender_create_ns = os_gettime_ns() - r->creation.texrender_create_offset_ns;
  bool valid = r->effect && r->target &&
               gs_effect_get_param_by_name(r->effect, "image") &&
               gs_effect_get_param_by_name(r->effect, "uv_scale") &&
               gs_effect_get_param_by_name(r->effect, "uv_min") &&
               gs_effect_get_param_by_name(r->effect, "uv_max") &&
               gs_effect_get_param_by_name(r->effect, "extent") &&
               gs_effect_get_param_by_name(r->effect, "solid") &&
               gs_effect_get_technique(r->effect, "Draw") &&
               gs_effect_get_technique(r->effect, "Nonce");
  if (!valid) {
    gs_texrender_destroy(r->target);
    release_effect(r->effect);
  }
  obs_leave_graphics();
  if (!valid) { free(r); return NULL; }
  return r;
}
static void destroy(void *data) {
  struct raster *r = data;
  if (!r) return;
  obs_enter_graphics();
  gs_texrender_destroy(r->target);
  release_effect(r->effect);
  obs_leave_graphics();
  free(r);
}
static void render(void *data, gs_effect_t *unused) {
  (void)unused;
  struct raster *r = data;
  if (!atomic_load_explicit(&r->ready, memory_order_acquire)) return;
  gs_texture_t *image = gs_texrender_get_texture(r->target);
  if (!image) return;
  const bool linear = gs_get_linear_srgb();
  const bool framebuffer = gs_framebuffer_srgb_enabled();
  gs_enable_framebuffer_srgb(linear);
  gs_eparam_t *parameter = gs_effect_get_param_by_name(r->effect, "image");
  if (linear) gs_effect_set_texture_srgb(parameter, image);
  else gs_effect_set_texture(parameter, image);
  const struct vec2 scale = {(float)r->physical_width / r->target_width,
                             (float)r->physical_height / r->target_height};
  gs_effect_set_vec2(gs_effect_get_param_by_name(r->effect, "uv_scale"), &scale);
  const struct vec2 minimum = {.5f / r->target_width, .5f / r->target_height};
  const struct vec2 maximum = {(r->physical_width - .5f) / r->target_width,
                               (r->physical_height - .5f) / r->target_height};
  /* Clamp to visible texel centers: an enlarged placement must never blend
   * its edge with the hidden browser/completion marker rows or padded columns. */
  gs_effect_set_vec2(gs_effect_get_param_by_name(r->effect, "uv_min"), &minimum);
  gs_effect_set_vec2(gs_effect_get_param_by_name(r->effect, "uv_max"), &maximum);
  const struct vec2 extent = {r->width * r->density, r->height * r->density};
  gs_effect_set_vec2(gs_effect_get_param_by_name(r->effect, "extent"), &extent);
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  gs_technique_t *technique = gs_effect_get_technique(r->effect, "Draw");
  size_t passes = gs_technique_begin(technique);
  for (size_t i = 0; i < passes; i++)
    if (gs_technique_begin_pass(technique, i)) {
      gs_draw_sprite(image, 0, r->width, r->height);
      gs_technique_end_pass(technique);
    }
  gs_technique_end(technique);
  gs_blend_state_pop();
  gs_enable_framebuffer_srgb(framebuffer);
}
void producer_set_v2_raster_register(void) {
  struct obs_source_info info = {0};
  info.id = RASTER_ID;
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
  info.get_name = name; info.create = create; info.destroy = destroy;
  info.get_width = width; info.get_height = height; info.video_render = render;
  obs_register_source_s(&info, sizeof(info));
}
obs_source_t *producer_set_v2_raster_create(uint32_t w, uint32_t h, float density) {
  const uint64_t started = os_gettime_ns();
  uint32_t pw, ph;
  if (!dimensions(w, h, density, &pw, &ph)) return NULL;
  char json[160];
  snprintf(json, sizeof(json), "{\"width\":%u,\"height\":%u,\"density\":%.9g}",
           w, h, density);
  obs_data_t *settings = obs_data_create_from_json(json);
  if (!settings) return NULL;
  obs_source_t *source = obs_source_create_private(RASTER_ID, "Set raster", settings);
  obs_data_release(settings);
  if (source && !get(source)) { obs_source_release(source); return NULL; }
  if (source) {
    struct raster *r = get(source);
    /* Includes JSON creation, libOBS initialization before our callback and
     * bookkeeping after it. Publish only fully validated outer-call offsets. */
    if (finish_creation_stats(&r->creation, started, os_gettime_ns()))
      atomic_store_explicit(&r->creation_pending, true, memory_order_release);
  }
  return source;
}
bool producer_set_v2_raster_take_creation_stats(
    obs_source_t *snapshot, struct producer_set_v2_raster_creation_stats *out) {
  if (!out) return false;
  memset(out, 0, sizeof(*out));
  struct raster *r = get(snapshot);
  if (!r || !atomic_exchange_explicit(&r->creation_pending, false, memory_order_acq_rel))
    return false;
  *out = r->creation;
  return true;
}
#ifdef PRODUCER_SET_V2_PROBE
bool producer_set_v2_raster_probe_creation_stats_bounds(void) {
  const struct producer_set_v2_raster_creation_stats absolute = {
      .graphics_wait_offset_ns = 125, .graphics_wait_ns = 10,
      .effect_compile_offset_ns = 140, .effect_compile_ns = 20,
      .texrender_create_offset_ns = 170, .texrender_create_ns = 5,
      .effect_compiled = 1};
  struct producer_set_v2_raster_creation_stats stats = absolute;
  if (!finish_creation_stats(&stats, 100, 200) || stats.elapsed_ns != 100 ||
      stats.graphics_wait_offset_ns != 25 || stats.effect_compile_offset_ns != 40 ||
      stats.texrender_create_offset_ns != 70) return false;
  /* The 25ns pre-callback wrapper prefix survives; invalid arithmetic never
   * turns into a wrapped or partially published component receipt. */
  for (int fault = 0; fault < 4; fault++) {
    stats = absolute;
    if (fault == 0) stats.graphics_wait_offset_ns = 99;
    if (fault == 1) stats.texrender_create_ns = UINT64_MAX;
    if (fault == 2) stats.effect_compiled = 2;
    struct producer_set_v2_raster_creation_stats before = stats;
    if (finish_creation_stats(&stats, 100, fault == 3 ? 90 : 200) ||
        memcmp(&stats, &before, sizeof(stats))) return false;
  }
  return true;
}
typedef struct obs_weak_source obs_weak_source_t;
OBS_IMPORT obs_weak_source_t *obs_source_get_weak_source(obs_source_t *);
OBS_IMPORT bool obs_weak_source_expired(obs_weak_source_t *);
#define INPUT_OBSERVERS 256
static obs_weak_source_t *observed_inputs[INPUT_OBSERVERS];
static size_t observed_count, observed_overflow;
static int next_probe_fault;
void producer_set_v2_raster_probe_fail_next(int fault) {
  obs_enter_graphics(); next_probe_fault = fault; obs_leave_graphics();
}
static void observe_input(struct raster *r, obs_source_t *input) {
  if (r->input_observed || strcmp(obs_source_get_id(input), "browser_source")) return;
  r->input_observed = true;
  if (observed_count == INPUT_OBSERVERS) { observed_overflow++; return; }
  obs_weak_source_t *weak = obs_source_get_weak_source(input);
  if (weak) observed_inputs[observed_count++] = weak;
  else observed_overflow++;
}
size_t producer_set_v2_raster_probe_live_inputs(void) {
  obs_enter_graphics(); size_t live = 0;
  for (size_t i = 0; i < observed_count; i++)
    if (!obs_weak_source_expired(observed_inputs[i])) live++;
  obs_leave_graphics(); return live;
}
size_t producer_set_v2_raster_probe_tracked_inputs(void) {
  obs_enter_graphics(); size_t count = observed_count; obs_leave_graphics(); return count;
}
size_t producer_set_v2_raster_probe_input_overflow(void) {
  obs_enter_graphics(); size_t count = observed_overflow; obs_leave_graphics(); return count;
}
#endif
static void draw_nonce(struct raster *r, const uint8_t bytes[18]) {
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
  for (int pixel = 0; pixel < 6; pixel++) {
    const uint8_t *p = bytes + pixel * 3;
    const struct vec4 value = {p[0] / 255.f, p[1] / 255.f, p[2] / 255.f, 1};
    gs_effect_set_vec4(gs_effect_get_param_by_name(r->effect, "solid"), &value);
    gs_matrix_push();
    gs_matrix_translate3f(pixel + 6, r->physical_height, 0);
    gs_technique_t *technique = gs_effect_get_technique(r->effect, "Nonce");
    size_t passes = gs_technique_begin(technique);
    for (size_t i = 0; i < passes; i++)
      if (gs_technique_begin_pass(technique, i)) {
        gs_draw_sprite(NULL, 0, 1, 1);
        gs_technique_end_pass(technique);
      }
    gs_technique_end(technique);
    gs_matrix_pop();
  }
}
static bool matches_fence(const uint8_t *pixels, uint32_t stride,
                          uint32_t width, uint32_t row, uint32_t column,
                          const uint8_t expected[18]) {
  if (!pixels || width < column + 6 || stride < width * 4) return false;
  pixels += (size_t)row * stride + column * 4;
  for (int i = 0; i < 6; i++)
    if (pixels[i * 4] != expected[i * 3] ||
        pixels[i * 4 + 1] != expected[i * 3 + 1] ||
        pixels[i * 4 + 2] != expected[i * 3 + 2] || pixels[i * 4 + 3] != 255)
      return false;
  return true;
}
struct capture_request { obs_source_t *snapshot, *input; bool captured, quarantined; };
static void capture_on_graphics(void *data) {
  struct capture_request *request = data;
  struct raster *r = get(request->snapshot);
  obs_enter_graphics();
  if (!r || atomic_load(&captures_disabled) ||
      atomic_load_explicit(&r->ready, memory_order_acquire) ||
      !(obs_source_get_output_flags(request->input) & OBS_SOURCE_VIDEO) ||
      obs_source_filter_count(request->input) ||
      obs_source_get_width(request->input) != (r->physical_width < 6 ? 6 : r->physical_width) ||
      obs_source_get_height(request->input) != r->physical_height + 1) {
    obs_leave_graphics(); return;
  }
  const enum gs_color_space preferred = GS_CS_SRGB;
  if (obs_source_get_color_space(request->input, 1, &preferred) != GS_CS_SRGB) {
    obs_leave_graphics(); return;
  }
  if (next_nonce == UINT64_MAX) {
    atomic_store(&captures_disabled, true);
    obs_leave_graphics(); return;
  }
  uint8_t expected[18]; fence_bytes(expected, next_nonce++, 0x5aa5);
#ifdef PRODUCER_SET_V2_PROBE
  observe_input(r, request->input);
  const int fault = next_probe_fault; next_probe_fault = 0;
#else
  const int fault = 0;
#endif
  const bool previous_linear = gs_set_linear_srgb(false);
  const bool previous_framebuffer = gs_framebuffer_srgb_enabled();
  gs_enable_framebuffer_srgb(false);
  /* Allocate every transient destination before any input GPU read. */
  gs_stagesurf_t *stage = fault == 1 ? NULL : gs_stagesurface_create(r->target_width, r->target_height, GS_RGBA);
  if (!stage) goto restored;
#ifdef PRODUCER_SET_V2_PROBE
  if (fault == 3) {
    /* Seed the test's read-only staging buffer via a real GPU clear/copy,
     * never by writing a GL_READ_ONLY mapping. A subsequent skipped transfer
     * therefore deterministically retains zero rather than the fresh nonce. */
    gs_texrender_reset(r->target);
    if (!gs_texrender_begin(r->target, r->target_width, r->target_height)) goto restored;
    const struct vec4 zero = {0, 0, 0, 0}; gs_clear(GS_CLEAR_COLOR, &zero, 0, 0);
    gs_texrender_end(r->target);
    gs_stage_texture(stage, gs_texrender_get_texture(r->target));
    uint8_t *bytes = NULL; uint32_t row_stride = 0;
    bool cleared = gs_stagesurface_map(stage, &bytes, &row_stride);
    if (cleared) {
      cleared = bytes && row_stride >= r->target_width * 4;
      if (cleared) {
        const uint8_t *row = bytes + (size_t)r->physical_height * row_stride + 6 * 4;
        for (int i = 0; i < 24; i++) if (row[i]) cleared = false;
      }
      gs_stagesurface_unmap(stage);
    }
    if (!cleared) goto restored;
  }
#endif
  gs_texrender_reset(r->target);
  if (!gs_texrender_begin(r->target, r->target_width, r->target_height))
    goto restored;
  atomic_store(&r->resident_bytes,
               (size_t)r->target_width * r->target_height * 4);
  const struct vec4 clear = {0, 0, 0, 0};
  gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
  gs_ortho(0, r->target_width, 0, r->target_height, -100, 100);
  gs_matrix_push(); gs_matrix_identity();
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  /* Marker and image are sampled in one source render. Output UVs exclude the
   * browser marker and our private fence row without rescaling visible pixels. */
  if (fault != 2) obs_source_video_render(request->input);
  gs_set_linear_srgb(false); gs_enable_framebuffer_srgb(false);
  draw_nonce(r, expected);
  gs_blend_state_pop(); gs_matrix_pop(); gs_texrender_end(r->target);
  bool complete = false;
  for (int attempt = 0; attempt < 2 && !complete; attempt++) {
    if (fault != 3) gs_stage_texture(stage, gs_texrender_get_texture(r->target));
    uint8_t *pixels = NULL; uint32_t stride = 0;
    if (fault != 4 && gs_stagesurface_map(stage, &pixels, &stride)) {
      if (pixels && stride >= r->target_width * 4) {
        complete = matches_fence(pixels, stride, r->target_width,
                                 r->physical_height, 6, expected);
        request->captured = complete && matches_fence(pixels, stride, r->target_width,
                                                       r->physical_height, 0, r->marker);
      }
      gs_stagesurface_unmap(stage);
    }
  }
  if (request->captured)
    atomic_store_explicit(&r->ready, true, memory_order_release);
  if (!complete) {
    /* Do not release a possibly in-flight CEF image, including its visibility
     * leases. This terminal driver-failure bound cannot grow on later calls. */
    atomic_store(&captures_disabled, true);
    request->quarantined = true;
    quarantined_snapshot = request->snapshot;
    quarantined_input = request->input;
    quarantined_stage = stage;
    memcpy(quarantined_nonce, expected, sizeof(expected));
    atomic_store(&quarantine_count, 1);
  }
restored:
  if (stage && !request->quarantined) gs_stagesurface_destroy(stage);
  gs_enable_framebuffer_srgb(previous_framebuffer);
  gs_set_linear_srgb(previous_linear);
  obs_leave_graphics();
}
bool producer_set_v2_raster_capture(obs_source_t *snapshot, obs_source_t *input) {
  if (!snapshot || !input || snapshot == input || atomic_load(&captures_disabled) || gs_get_context() ||
      obs_in_task_thread(1)) return false;
  struct capture_request request = {obs_source_get_ref(snapshot),
                                    obs_source_get_ref(input), false, false};
  bool leased = request.snapshot && request.input && get(request.snapshot);
  if (leased) {
    obs_source_inc_active(request.input); obs_source_inc_showing(request.input);
    obs_queue_task(1, capture_on_graphics, &request, true);
  }
  if (!request.quarantined) {
    if (leased) { obs_source_dec_showing(request.input); obs_source_dec_active(request.input); }
    if (request.input) obs_source_release(request.input);
    if (request.snapshot) obs_source_release(request.snapshot);
  }
  return request.captured;
}
bool producer_set_v2_raster_ready(obs_source_t *snapshot) {
  struct raster *r = get(snapshot);
  return r && atomic_load_explicit(&r->ready, memory_order_acquire);
}
bool producer_set_v2_raster_get_marker(obs_source_t *snapshot, uint8_t *out18) {
  if (!out18) return false;
  memset(out18, 0, 18);
  struct raster *r = get(snapshot);
  if (!r) return false;
  memcpy(out18, r->marker, 18); return true;
}
bool producer_set_v2_raster_copy_blocked(void) { return atomic_load(&captures_disabled); }
size_t producer_set_v2_raster_quarantine_count(void) { return atomic_load(&quarantine_count); }
size_t producer_set_v2_raster_texture_bytes(obs_source_t *snapshot) {
  struct raster *r = get(snapshot);
  return r ? atomic_load(&r->resident_bytes) : 0;
}
#ifdef PRODUCER_SET_V2_PROBE
static void probe_recover(void *data) {
  bool *recovered = data; obs_enter_graphics();
  struct raster *r = get(quarantined_snapshot);
  if (r && quarantined_stage && atomic_load(&quarantine_count) == 1) {
    gs_stage_texture(quarantined_stage, gs_texrender_get_texture(r->target));
    uint8_t *pixels = NULL; uint32_t stride = 0;
    if (gs_stagesurface_map(quarantined_stage, &pixels, &stride)) {
      *recovered = matches_fence(pixels, stride, r->target_width,
                                 r->physical_height, 6, quarantined_nonce);
      gs_stagesurface_unmap(quarantined_stage);
    }
    if (*recovered) { gs_stagesurface_destroy(quarantined_stage); quarantined_stage = NULL; }
  }
  obs_leave_graphics();
}
bool producer_set_v2_raster_probe_recover_quarantine(void) {
  if (gs_get_context() || obs_in_task_thread(1)) return false;
  bool recovered = false;
  obs_queue_task(1, probe_recover, &recovered, true);
  if (!recovered) return false;
  obs_source_dec_showing(quarantined_input); obs_source_dec_active(quarantined_input);
  obs_source_release(quarantined_input); obs_source_release(quarantined_snapshot);
  quarantined_input = quarantined_snapshot = NULL;
  atomic_store(&quarantine_count, 0); atomic_store(&captures_disabled, false);
  return true;
}
#endif
