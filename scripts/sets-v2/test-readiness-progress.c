/* Deterministic actual-readiness.c control-flow test. The fake OBS/graphics
 * backend never loads libobs, creates a device, or opens Producer. Real pixel
 * behavior is covered separately by graphics-cache-proof.inc.m. */
#include "sets_v2/readiness.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct obs_source { uint32_t width, height; uint8_t rgba[4]; size_t renders; };
struct gs_texture { uint8_t pixels[24]; };
struct gs_texture_render { struct gs_texture texture; };
struct gs_stage_surface { uint8_t pixels[24]; uint32_t width; };
static gs_texrender_t *target;
static size_t queues, allocations, graphics_depth;
static bool fail_target, fail_stage, fail_begin, fail_map, null_pixel;
static uint32_t map_stride = 4;

void obs_enter_graphics(void) { graphics_depth++; }
void obs_leave_graphics(void) { assert(graphics_depth); graphics_depth--; }
void obs_queue_task(int type, void (*task)(void *), void *data, bool wait) {
  assert(type == 1 && wait && !graphics_depth);
  queues++;
  task(data); /* Verify the real synchronous task consumes caller-owned arrays. */
  assert(!graphics_depth && !target);
}
uint32_t obs_source_get_width(obs_source_t *source) { return source->width; }
uint32_t obs_source_get_height(obs_source_t *source) { return source->height; }
void obs_source_video_render(obs_source_t *source) {
  assert(graphics_depth && target);
  source->renders++;
  for (size_t i = 0; i < 6; i++) memcpy(target->texture.pixels + i * 4, source->rgba, 4);
}
gs_texrender_t *gs_texrender_create(enum gs_color_format format, enum gs_zstencil_format zs) {
  assert(graphics_depth && format == GS_RGBA && zs == GS_ZS_NONE);
  if (fail_target) return NULL;
  allocations++;
  return calloc(1, sizeof(gs_texrender_t));
}
void gs_texrender_destroy(gs_texrender_t *value) { if (value) { allocations--; free(value); } }
bool gs_texrender_begin(gs_texrender_t *value, uint32_t width, uint32_t height) {
  assert(graphics_depth && value && width && height);
  if (fail_begin) return false;
  target = value;
  return true;
}
void gs_texrender_end(gs_texrender_t *value) { assert(target == value); target = NULL; }
gs_texture_t *gs_texrender_get_texture(const gs_texrender_t *value) { return (gs_texture_t *)&value->texture; }
gs_stagesurf_t *gs_stagesurface_create(uint32_t width, uint32_t height, enum gs_color_format format) {
  assert(graphics_depth && width <= 6 && height == 1 && format == GS_RGBA);
  if (fail_stage) return NULL;
  gs_stagesurf_t *value = calloc(1, sizeof(*value));
  value->width = width;
  allocations++;
  return value;
}
void gs_stagesurface_destroy(gs_stagesurf_t *value) { if (value) { allocations--; free(value); } }
void gs_stage_texture(gs_stagesurf_t *stage, gs_texture_t *texture) {
  assert(graphics_depth);
  memcpy(stage->pixels, texture->pixels, stage->width * 4);
}
bool gs_stagesurface_map(gs_stagesurf_t *stage, uint8_t **pixels, uint32_t *stride) {
  if (fail_map) return false;
  *pixels = null_pixel ? NULL : stage->pixels;
  *stride = map_stride;
  return true;
}
void gs_stagesurface_unmap(gs_stagesurf_t *stage) { (void)stage; }
void gs_clear(uint32_t flags, const struct vec4 *color, float depth, uint8_t stencil) {
  (void)flags; (void)color; (void)depth; (void)stencil;
}
void gs_ortho(float left, float right, float top, float bottom, float near, float far) {
  (void)left; (void)right; (void)top; (void)bottom; (void)near; (void)far;
}
void gs_matrix_push(void) {}
void gs_matrix_pop(void) {}
void gs_matrix_identity(void) {}
void gs_matrix_translate3f(float x, float y, float z) { (void)x; (void)y; (void)z; }
void gs_blend_state_push(void) {}
void gs_blend_state_pop(void) {}
void gs_blend_function(enum gs_blend_type source, enum gs_blend_type destination) { (void)source; (void)destination; }

static obs_source_t ready(void) { return (obs_source_t){1, 2, {1, 254, 3, 255}, 0}; }
static size_t progress(obs_source_t *const *sources, const uint32_t *rows, size_t count) {
  size_t verified = 999;
  assert(producer_set_v2_surface_marker_progress(sources, rows, count, &verified));
  assert(!allocations && !graphics_depth && !target);
  return verified;
}
int main(void) {
  obs_source_t a = ready(), b = ready(), c = ready();
  obs_source_t *sources[] = {&a, &b, &c};
  uint32_t rows[] = {1, 1, 1};
  b.rgba[1] = 0;
  assert(progress(sources, rows, 3) == 1);
  assert(a.renders == 1 && b.renders == 1 && c.renders == 0 && queues == 1);
  /* Caller retains only the first real receipt while the source stays leased.
   * A later poll checks the remaining suffix, without repainting A. */
  b.rgba[1] = 254;
  assert(progress(sources + 1, rows + 1, 2) == 2);
  assert(a.renders == 1 && b.renders == 2 && c.renders == 1 && queues == 2);
  assert(producer_set_v2_surface_markers(sources, rows, 3));
  b.rgba[3] = 254;
  assert(!producer_set_v2_surface_markers(sources, rows, 3));
  b.rgba[3] = 255;

  size_t before = queues, verified = 999;
  assert(progress(NULL, NULL, 0) == 0 && queues == before);
  assert(producer_set_v2_surface_markers(NULL, NULL, 0));
  assert(!producer_set_v2_surface_marker_progress(sources, rows, 1, NULL));
  assert(!producer_set_v2_surface_marker_progress(NULL, rows, 1, &verified) && !verified);
  verified = 999;
  assert(!producer_set_v2_surface_marker_progress(sources, NULL, 1, &verified) && !verified);
  verified = 999;
  assert(!producer_set_v2_surface_marker_progress((void *)1, (void *)1, 17, &verified) && !verified);
  obs_source_t *invalid[] = {&a, NULL, &c};
  verified = 999;
  assert(!producer_set_v2_surface_marker_progress(invalid, rows, 3, &verified) && !verified);
  assert(queues == before); /* Even a later null source rejects all progress. */

  obs_source_t *maximum[16]; uint32_t maximum_rows[16];
  for (size_t i = 0; i < 16; i++) { maximum[i] = &a; maximum_rows[i] = 1; }
  assert(progress(maximum, maximum_rows, 16) == 16);
  for (size_t channel = 0; channel < 4; channel++) {
    uint8_t original = a.rgba[channel]; a.rgba[channel] ^= 1;
    assert(progress(sources, rows, 1) == 0); a.rgba[channel] = original;
  }
  rows[0] = a.height;
  before = a.renders;
  assert(progress(sources, rows, 1) == 0 && a.renders == before);
  rows[0] = 1;
  a.width = 0;
  assert(progress(sources, rows, 1) == 0 && a.renders == before);
  a.width = 1;
  bool *failures[] = {&fail_target, &fail_stage, &fail_begin, &fail_map, &null_pixel};
  for (size_t i = 0; i < sizeof(failures) / sizeof(*failures); i++) {
    *failures[i] = true; assert(progress(sources, rows, 1) == 0); *failures[i] = false;
  }
  map_stride = 3;
  assert(progress(sources, rows, 1) == 0);
  map_stride = 4;
  assert(progress(sources, rows, 1) == 1);
  puts("PASS: actual readiness.c retains only exact verified prefixes, rejects invalid batches, preserves the legacy fence, and cleans up failed probes.");
  return 0;
}
