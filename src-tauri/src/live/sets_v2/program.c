#include "program.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ID "producer_set_v2_program"
/* libobs invokes enum callbacks outside the graphics thread too. This lock
 * protects only the child pointer snapshot; no libobs graph call holds it. All
 * rendering, state changes and owner calls are serialized by graphics context.
 */
struct program {
  obs_source_t *source, *current, *pending, *transition, *retiring;
  obs_source_t *children[4];
  atomic_flag children_lock;
  gs_texrender_t *warm;
  uint32_t width, height;
  uint64_t latest_revision, prepared_revision, current_revision,
      rendered_revision, serial;
  double clock_ms, start_ms, duration_ms, progress;
  bool warmed, ready, queued, transitioning, paused;
};
static atomic_size_t live = 0;
static void lock(struct program *p) {
  while (atomic_flag_test_and_set_explicit(&p->children_lock,
                                           memory_order_acquire)) {
  }
}
static void unlock(struct program *p) {
  atomic_flag_clear_explicit(&p->children_lock, memory_order_release);
}
static void snapshot_children(struct program *p) {
  lock(p);
  p->children[0] = p->current;
  p->children[1] = p->pending;
  p->children[2] = p->transition;
  p->children[3] = p->retiring;
  unlock(p);
}
static const char *name(void *p) {
  (void)p;
  return "Producer set v2 program";
}
static uint32_t width(void *p) { return ((struct program *)p)->width; }
static uint32_t height(void *p) { return ((struct program *)p)->height; }
static void *create(obs_data_t *settings, obs_source_t *source) {
  double w = obs_data_get_double(settings, "width"),
         h = obs_data_get_double(settings, "height");
  if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > 8192 || h > 8192 ||
      floor(w) != w || floor(h) != h || w * h > 4096u * 4096u)
    return NULL;
  struct program *p = calloc(1, sizeof(*p));
  if (!p)
    return NULL;
  atomic_flag_clear(&p->children_lock);
  p->source = source;
  p->width = w;
  p->height = h;
  obs_enter_graphics();
  p->warm = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  obs_leave_graphics();
  if (!p->warm) {
    free(p);
    return NULL;
  }
  atomic_fetch_add(&live, 1);
  return p;
}
static void detach(struct program *p, obs_source_t *s) {
  if (s) {
    obs_source_remove_active_child(p->source, s);
    obs_source_release(s);
  }
}
static void destroy(void *data) {
  struct program *p = data;
  if (!p)
    return;
  detach(p, p->current);
  detach(p, p->pending);
  detach(p, p->transition);
  detach(p, p->retiring);
  obs_enter_graphics();
  gs_texrender_destroy(p->warm);
  obs_leave_graphics();
  atomic_fetch_sub(&live, 1);
  free(p);
}
static void children(void *data, void *callback, void *param) {
  struct program *p = data;
  obs_source_t *refs[4];
  lock(p);
  for (size_t i = 0; i < 4; i++)
    refs[i] = p->children[i] ? obs_source_get_ref(p->children[i]) : NULL;
  unlock(p);
  for (size_t i = 0; i < 4; i++)
    if (refs[i]) {
      ((void (*)(obs_source_t *, obs_source_t *, void *))callback)(
          p->source, refs[i], param);
      obs_source_release(refs[i]);
    }
}
static void tick(void *data, float seconds) {
  struct program *p = data;
  /* OBS video ticks supply monotonic elapsed time, independent of UI/network
   * delivery. Sampling the same source twice in one frame doesn't advance it.
   */
  obs_enter_graphics();
  if (!p->paused && isfinite(seconds) && seconds >= 0)
    p->clock_ms += (double)seconds * 1000.;
  obs_leave_graphics();
}
static bool warm(struct program *p) {
  gs_texrender_reset(p->warm);
  if (!gs_texrender_begin(p->warm, p->width, p->height))
    return false;
  struct vec4 clear = {0, 0, 0, 0};
  gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
  gs_ortho(0, p->width, 0, p->height, -100, 100);
  gs_matrix_push();
  gs_matrix_identity();
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  obs_source_video_render(p->pending);
  gs_blend_state_pop();
  gs_matrix_pop();
  gs_texrender_end(p->warm);
  return gs_texrender_get_texture(p->warm) != NULL;
}
static void render(void *data, gs_effect_t *unused) {
  (void)unused;
  struct program *p = data;
  if (p->pending && !p->warmed)
    p->warmed = warm(p);
  if (p->queued && p->warmed && p->ready) {
    p->retiring = p->current;
    p->current = p->pending;
    p->pending = NULL;
    p->queued = false;
    p->current_revision = p->prepared_revision;
    p->start_ms = p->clock_ms;
    p->transitioning = p->transition != NULL;
    snapshot_children(p);
  }
  if (!p->current)
    return;
  p->serial++;
  if (p->transitioning) {
    p->progress =
        fmin(1., fmax(0., (p->clock_ms - p->start_ms) / p->duration_ms));
    producer_set_v2_transition_frame(p->transition, (float)p->progress);
    obs_source_video_render(p->transition);
    if (p->progress >= 1.) {
      p->transitioning = false;
      p->rendered_revision = p->current_revision;
    }
  } else {
    obs_source_video_render(p->current);
    p->progress = 1.;
    p->rendered_revision = p->current_revision;
  }
}
void producer_set_v2_program_register(void) {
  struct obs_source_info i = {0};
  i.id = ID;
  i.type = OBS_SOURCE_TYPE_INPUT;
  i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  i.get_name = name;
  i.create = create;
  i.destroy = destroy;
  i.get_width = width;
  i.get_height = height;
  i.video_tick = tick;
  i.video_render = render;
  i.enum_active_sources = children;
  i.enum_all_sources = children;
  obs_register_source_s(&i, sizeof(i));
}
static struct program *get(obs_source_t *s) {
  return s && !strcmp(obs_source_get_id(s), ID) ? obs_obj_get_data(s) : NULL;
}
obs_source_t *producer_set_v2_program_create(uint32_t w, uint32_t h) {
  char json[96];
  snprintf(json, sizeof(json), "{\"width\":%u,\"height\":%u}", w, h);
  obs_data_t *d = obs_data_create_from_json(json);
  if (!d)
    return NULL;
  obs_source_t *s = obs_source_create_private(ID, "Set v2 program", d);
  obs_data_release(d);
  if (s && !get(s)) {
    obs_source_release(s);
    return NULL;
  }
  return s;
}
static void collect(struct program *p) {
  if (p->transitioning || p->queued)
    return;
  obs_source_t *t = p->transition, *r = p->retiring;
  p->transition = NULL;
  p->retiring = NULL;
  snapshot_children(p);
  detach(p, t);
  detach(p, r);
}
bool producer_set_v2_program_prepare(obs_source_t *s, obs_source_t *candidate,
                                     uint64_t revision) {
  struct program *p = get(s);
  if (!p || !candidate || candidate == s || !revision ||
      !(obs_source_get_output_flags(candidate) & OBS_SOURCE_VIDEO) ||
      obs_source_get_width(candidate) != p->width ||
      obs_source_get_height(candidate) != p->height)
    return false;
  obs_enter_graphics();
  if (p->transitioning || p->queued || revision <= p->latest_revision) {
    obs_leave_graphics();
    return false;
  }
  collect(p);
  obs_source_t *ref = obs_source_get_ref(candidate);
  if (!ref || !obs_source_add_active_child(s, ref)) {
    if (ref)
      obs_source_release(ref);
    obs_leave_graphics();
    return false;
  }
  obs_source_t *old = p->pending;
  p->pending = ref;
  p->latest_revision = revision;
  p->prepared_revision = revision;
  p->warmed = false;
  p->ready = false;
  snapshot_children(p);
  detach(p, old);
  obs_leave_graphics();
  return true;
}
bool producer_set_v2_program_ready(obs_source_t *s, uint64_t revision) {
  struct program *p = get(s);
  if (!p)
    return false;
  obs_enter_graphics();
  bool ok = p->pending && p->prepared_revision == revision;
  if (ok)
    p->ready = true;
  obs_leave_graphics();
  return ok;
}
bool producer_set_v2_program_take(obs_source_t *s, uint64_t revision,
                                  double duration,
                                  enum producer_set_v2_transition_mode mode) {
  struct program *p = get(s);
  if (!p || !isfinite(duration) || duration < 0 || duration > 10000 ||
      mode < 0 || mode > 2)
    return false;
  obs_enter_graphics();
  if (!p->pending || !p->ready || !p->warmed || p->queued || p->transitioning ||
      p->prepared_revision != revision) {
    obs_leave_graphics();
    return false;
  }
  obs_source_t *t = NULL;
  if (p->current && duration > 0) {
    t = producer_set_v2_transition_create(p->current, p->pending, p->width,
                                          p->height, mode);
    if (!t || !obs_source_add_active_child(s, t)) {
      if (t)
        obs_source_release(t);
      obs_leave_graphics();
      return false;
    }
  }
  p->transition = t;
  p->duration_ms = duration;
  p->queued = true;
  p->progress = 0;
  snapshot_children(p);
  obs_leave_graphics();
  return true;
}
bool producer_set_v2_program_cancel(obs_source_t *s, uint64_t revision) {
  struct program *p = get(s);
  if (!p)
    return false;
  obs_enter_graphics();
  bool ok = p->pending && p->prepared_revision == revision && !p->transitioning;
  if (ok) {
    obs_source_t *old = p->pending, *t = p->transition;
    p->pending = NULL;
    p->transition = NULL;
    p->queued = false;
    p->warmed = false;
    p->ready = false;
    p->prepared_revision = p->rendered_revision;
    snapshot_children(p);
    detach(p, t);
    detach(p, old);
  }
  obs_leave_graphics();
  return ok;
}
bool producer_set_v2_program_pause(obs_source_t *s, bool paused) {
  struct program *p = get(s);
  if (!p)
    return false;
  obs_enter_graphics();
  p->paused = paused;
  obs_leave_graphics();
  return true;
}
bool producer_set_v2_program_status(
    obs_source_t *s, struct producer_set_v2_program_status *out) {
  struct program *p = get(s);
  if (!p || !out)
    return false;
  obs_enter_graphics();
  *out = (struct producer_set_v2_program_status){p->prepared_revision,
                                                 p->rendered_revision,
                                                 p->serial,
                                                 p->clock_ms,
                                                 p->progress,
                                                 p->warmed,
                                                 p->ready,
                                                 p->queued,
                                                 p->transitioning,
                                                 p->paused};
  obs_leave_graphics();
  return true;
}
bool producer_set_v2_program_collect(obs_source_t *s) {
  struct program *p = get(s);
  if (!p)
    return false;
  obs_enter_graphics();
  collect(p);
  bool ok = !p->transitioning && !p->queued;
  obs_leave_graphics();
  return ok;
}
size_t producer_set_v2_live_programs(void) { return atomic_load(&live); }
