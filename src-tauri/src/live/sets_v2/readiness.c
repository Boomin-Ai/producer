#include <stdio.h>
#include <stdlib.h>
#include "readiness.h"
OBS_IMPORT void gs_matrix_translate3f(float x, float y, float z);
static bool surface_warm(obs_source_t *source) {
  if (!source)
    return false;
  obs_enter_graphics();
  gs_texrender_t *target = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  bool ready = false;
  if (target && gs_texrender_begin(target, 1, 1)) {
    struct vec4 clear = {0, 0, 0, 0};
    gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
    gs_ortho(0, 1, 0, 1, -100, 100);
    gs_matrix_push();
    gs_matrix_identity();
    obs_source_video_render(source);
    gs_matrix_pop();
    gs_texrender_end(target);
    ready =
        obs_source_get_width(source) > 0 && obs_source_get_height(source) > 0;
  }
  if (target)
    gs_texrender_destroy(target);
  obs_leave_graphics();
  return ready;
}
static bool surface_marker(obs_source_t *source, uint32_t x,
                                    uint32_t y, uint8_t red, uint8_t green,
                                    uint8_t blue) {
  if (!source || x >= obs_source_get_width(source) ||
      y >= obs_source_get_height(source))
    return false;
  obs_enter_graphics();
  gs_texrender_t *target = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  gs_stagesurf_t *stage = gs_stagesurface_create(1, 1, GS_RGBA);
  bool ready = false;
  if (target && stage && gs_texrender_begin(target, 1, 1)) {
    struct vec4 clear = {0, 0, 0, 0};
    gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
    gs_ortho(0, 1, 0, 1, -100, 100);
    gs_matrix_push();
    gs_matrix_identity();
    gs_matrix_translate3f(-(float)x, -(float)y, 0);
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
    obs_source_video_render(source);
    gs_blend_state_pop();
    gs_matrix_pop();
    gs_texrender_end(target);
    gs_stage_texture(stage, gs_texrender_get_texture(target));
    uint8_t *pixel = NULL;
    uint32_t stride = 0;
    if (gs_stagesurface_map(stage, &pixel, &stride)) {
      ready = pixel && stride >= 4 && pixel[0] == red && pixel[1] == green &&
              pixel[2] == blue && pixel[3] == 255;
      gs_stagesurface_unmap(stage);
    }
  }
  if (stage)
    gs_stagesurface_destroy(stage);
  if (target)
    gs_texrender_destroy(target);
  obs_leave_graphics();
  return ready;
}

/* Read one fence strip, avoiding six graphics synchronizations per poll. */
static bool surface_fence(obs_source_t *source, uint32_t y,
                                  const uint8_t *expected) {
  if (!source || !expected || obs_source_get_width(source) < 6 ||
      y >= obs_source_get_height(source)) return false;
  obs_enter_graphics();
  gs_texrender_t *target = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  gs_stagesurf_t *stage = gs_stagesurface_create(6, 1, GS_RGBA);
  bool ready = false;
  if (target && stage && gs_texrender_begin(target, 6, 1)) {
    struct vec4 clear = {0, 0, 0, 0};
    gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
    gs_ortho(0, 6, 0, 1, -100, 100);
    gs_matrix_push(); gs_matrix_identity();
    gs_matrix_translate3f(0, -(float)y, 0);
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
    obs_source_video_render(source);
    gs_blend_state_pop(); gs_matrix_pop(); gs_texrender_end(target);
    gs_stage_texture(stage, gs_texrender_get_texture(target));
    uint8_t *pixel = NULL; uint32_t stride = 0;
    if (gs_stagesurface_map(stage, &pixel, &stride)) {
      ready = pixel && stride >= 24;
      for (int i = 0; ready && i < 6; i++)
        ready = pixel[i*4] == expected[i*3] && pixel[i*4+1] == expected[i*3+1] &&
                pixel[i*4+2] == expected[i*3+2] && pixel[i*4+3] == 255;
      if (!ready && pixel && getenv("PRODUCER_SCENE3D_DEBUG")) {
        static unsigned failures = 0;
        if ((failures++ % 120) == 0) {
          fprintf(stderr, "3D fence y=%u actual=", y);
          for (int i=0;i<24;i++) fprintf(stderr,"%02x",pixel[i]);
          fprintf(stderr," expected=");
          for (int i=0;i<18;i++) fprintf(stderr,"%02x",expected[i]);
          fprintf(stderr,"\n");
        }
      }
      gs_stagesurface_unmap(stage);
    }
  }
  if (stage) gs_stagesurface_destroy(stage);
  if (target) gs_texrender_destroy(target);
  obs_leave_graphics(); return ready;
}

/* Source rendering must stay on the graphics thread. Entering the graphics
 * context on the owner thread serializes individual calls, but lets a source's
 * render/cache state be touched between the graphics thread's tick and draw.
 * Metal's current render target and the browser's per-frame textures belong to
 * that render lifecycle. Queue the entire probe, including allocation and
 * destruction, as one graphics task. Never wait while holding a graphics lock.
 */
OBS_IMPORT void obs_queue_task(int type, void (*task)(void *), void *param,
                               bool wait);
enum probe_kind { PROBE_WARM, PROBE_MARKER, PROBE_FENCE };
struct surface_probe {
  enum probe_kind kind;
  obs_source_t *source;
  uint32_t x, y;
  uint8_t rgb[3];
  const uint8_t *expected;
  bool ready;
};
static void probe_on_graphics(void *data) {
  struct surface_probe *p = data;
  switch (p->kind) {
  case PROBE_WARM:
    p->ready = surface_warm(p->source);
    break;
  case PROBE_MARKER:
    p->ready = surface_marker(p->source, p->x, p->y,
                              p->rgb[0], p->rgb[1], p->rgb[2]);
    break;
  case PROBE_FENCE:
    p->ready = surface_fence(p->source, p->y, p->expected);
    break;
  }
}
static bool probe(struct surface_probe *p) {
  if (!p->source) return false;
  /* OBS_TASK_GRAPHICS = 1. wait=true also executes inline when already on that
   * thread. The caller retains the source and expected bytes until return. */
  obs_queue_task(1, probe_on_graphics, p, true);
  return p->ready;
}
bool producer_set_v2_surface_warm(obs_source_t *source) {
  struct surface_probe p = {.kind = PROBE_WARM, .source = source};
  return probe(&p);
}
bool producer_set_v2_surface_marker(obs_source_t *source, uint32_t x,
                                    uint32_t y, uint8_t red, uint8_t green,
                                    uint8_t blue) {
  struct surface_probe p = {.kind = PROBE_MARKER, .source = source,
                            .x = x, .y = y, .rgb = {red, green, blue}};
  return probe(&p);
}
bool producer_set_v2_surface_fence(obs_source_t *source, uint32_t y,
                                  const uint8_t *expected) {
  struct surface_probe p = {.kind = PROBE_FENCE, .source = source,
                            .y = y, .expected = expected};
  return probe(&p);
}
