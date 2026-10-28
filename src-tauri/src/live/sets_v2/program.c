#include "program.h"
#include "scene.h"
#include "chart.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ID "producer_set_v2_program"
extern void producer_shader_frame(obs_source_t *, float, float, float, float);
struct effect_clock {
  obs_source_t *source;
  float intensity, scale, opacity;
  double base_ms, anchor_ms;
  bool running;
};
extern void obs_source_media_play_pause(obs_source_t *, bool);
extern void obs_source_media_set_time(obs_source_t *, int64_t);
extern int64_t obs_source_media_get_time(obs_source_t *);
struct media_clock {
  obs_source_t *source;
  bool playing;
  double position_ms;
};
/* libobs invokes enum callbacks outside the graphics thread too. This lock
 * protects only the child pointer snapshot; no libobs graph call holds it. All
 * rendering, state changes and owner calls are serialized by graphics context.
 */
struct motion_track {
  struct producer_set_v2_scene *scene;
  char target[65];
  obs_source_t *shader;
  int property, easing, loop;
  struct producer_set_v2_keyframe frames[64];
  size_t count;
  double base_ms, delay_ms, anchor_ms;
  bool running;
};
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
  obs_source_t *charts[4],*pending_charts[4],*retired_charts[4];size_t chart_count,pending_chart_count,retired_chart_count;
  struct effect_clock effects[32], pending_effects[32], retired_effects[32];
  size_t effect_count, pending_effect_count, retired_effect_count;
  struct media_clock media[24], pending_media[24];
  size_t media_count, pending_media_count;
  struct motion_track tracks[128], pending_tracks[128], retired_tracks[128];
  size_t track_count, pending_track_count, retired_track_count;
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
static void effects(struct effect_clock *items, size_t count, double clock) {
  for (size_t i = 0; i < count; i++) {
    struct effect_clock *e = &items[i];
    double ms = e->base_ms + (e->running ? fmax(0., clock - e->anchor_ms) : 0.);
    producer_shader_frame(e->source, (float)(ms / 1000.), e->intensity,
                          e->scale, e->opacity);
  }
}
static void animate(struct program *p, struct motion_track *tracks,
                    size_t count, double clock, bool holding) {
  for (size_t i = 0; i < count; i++) {
    struct motion_track *t = &tracks[i];
    double time = fmax(
        0., t->base_ms +
                (t->running && !holding ? fmax(0., clock - t->anchor_ms) : 0.) -
                t->delay_ms);
    double duration = t->frames[t->count - 1].at_ms;
    if (t->loop == 1)
      time = fmod(time, duration);
    if (t->loop == 2) {
      time = fmod(time, duration * 2);
      if (time > duration)
        time = duration * 2 - time;
    }
    float value = t->frames[t->count - 1].value;
    if (time < duration) {
      size_t k = 1;
      while (k < t->count && t->frames[k].at_ms < time)
        k++;
      double phase = (time - t->frames[k - 1].at_ms) /
                     (t->frames[k].at_ms - t->frames[k - 1].at_ms);
      if (t->easing == 1)
        phase *= phase;
      else if (t->easing == 2)
        phase = 1 - (1 - phase) * (1 - phase);
      else if (t->easing == 3)
        phase = phase * phase * (3 - 2 * phase);
      value = t->frames[k - 1].value +
              (t->frames[k].value - t->frames[k - 1].value) * (float)phase;
    }
    if (t->property == 7 || t->property == 8) {
      struct effect_clock *sets[] = {p->effects, p->pending_effects,
                                     p->retired_effects};
      size_t sizes[] = {p->effect_count, p->pending_effect_count,
                        p->retired_effect_count};
      for (size_t j = 0; j < 3; j++)
        for (size_t k = 0; k < sizes[j]; k++)
          if (sets[j][k].source == t->shader) {
            if (t->property == 7)
              sets[j][k].intensity = value;
            else
              sets[j][k].scale = value;
          }
    } else
      producer_set_v2_scene_frame(t->scene, t->target, t->property, value);
  }
}
static void render(void *data, gs_effect_t *unused) {
  (void)unused;
  struct program *p = data;
  for(size_t i=0;i<p->chart_count;i++)producer_chart_frame(p->charts[i],p->clock_ms);
  for(size_t i=0;i<p->retired_chart_count;i++)producer_chart_frame(p->retired_charts[i],p->clock_ms);
  animate(p, p->pending_tracks, p->pending_track_count, p->clock_ms, true);
  effects(p->pending_effects, p->pending_effect_count, p->clock_ms);
  if (p->pending && !p->warmed)
    p->warmed = warm(p);
  if (p->queued && p->warmed && p->ready) {
    p->retiring = p->current;
    p->current = p->pending;
    p->pending = NULL;
    p->queued = false;
    p->current_revision = p->prepared_revision;
    memcpy(p->retired_tracks, p->tracks, sizeof(p->tracks));
    p->retired_track_count = p->track_count;
    memcpy(p->tracks, p->pending_tracks, sizeof(p->tracks));
    p->track_count = p->pending_track_count;
    p->pending_track_count = 0;
    for (size_t i = 0; i < p->track_count; i++)
      p->tracks[i].anchor_ms = p->clock_ms;
    for(size_t i=0;i<p->pending_chart_count;i++){obs_source_t *previous=NULL;for(size_t j=0;j<p->chart_count;j++)if(!strcmp(producer_chart_key(p->pending_charts[i]),producer_chart_key(p->charts[j]))){previous=p->charts[j];break;}producer_chart_begin(p->pending_charts[i],previous,p->clock_ms);}
    memcpy(p->retired_charts,p->charts,sizeof(p->charts));p->retired_chart_count=p->chart_count;memcpy(p->charts,p->pending_charts,sizeof(p->charts));p->chart_count=p->pending_chart_count;
    memcpy(p->retired_effects, p->effects, sizeof(p->effects));
    p->retired_effect_count = p->effect_count;
    memcpy(p->effects, p->pending_effects, sizeof(p->effects));
    p->effect_count = p->pending_effect_count;
    p->pending_effect_count = 0;
  p->pending_chart_count = 0;
    p->pending_track_count = 0;
    for (size_t i = 0; i < p->effect_count; i++)
      p->effects[i].anchor_ms = p->clock_ms;
    /* Off-air resident players remain paused until their next entry. */
    for(size_t i=0;i<p->media_count;i++)obs_source_media_play_pause(p->media[i].source,true);
    memcpy(p->media, p->pending_media, sizeof(p->media));
    p->media_count = p->pending_media_count;
    p->pending_media_count = 0;
    for (size_t i = 0; i < p->media_count; i++) {
      struct media_clock *m = &p->media[i];
      if (fabs((double)obs_source_media_get_time(m->source) - m->position_ms) >
          50.)
        obs_source_media_set_time(m->source, (int64_t)m->position_ms);
      obs_source_media_play_pause(m->source, !m->playing || p->paused);
    }
    p->start_ms = p->clock_ms;
    p->transitioning = p->transition != NULL;
    snapshot_children(p);
  }
  animate(p, p->tracks, p->track_count, p->clock_ms, false);
  animate(p, p->retired_tracks, p->retired_track_count, p->clock_ms, false);
  effects(p->effects, p->effect_count, p->clock_ms);
  effects(p->retired_effects, p->retired_effect_count, p->clock_ms);
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
  i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
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
  p->retired_effect_count = 0;
  p->retired_chart_count = 0;
  p->retired_track_count = 0;
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
  p->pending_effect_count = 0;
  p->pending_chart_count = 0;
  p->pending_track_count = 0;
  p->pending_media_count = 0;
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
    p->pending_effect_count = 0;
  p->pending_chart_count = 0;
    p->pending_track_count = 0;
    p->pending_media_count = 0;
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
  for (size_t i = 0; i < p->media_count; i++)
    obs_source_media_play_pause(p->media[i].source,
                                paused || !p->media[i].playing);
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
bool producer_set_v2_program_media(obs_source_t *s, uint64_t revision,
                                   obs_source_t *media, bool playing,
                                   double position) {
  struct program *p = get(s);
  if (!p || !media || strcmp(obs_source_get_id(media), "ffmpeg_source") ||
      !isfinite(position) || position < 0 || position > 86400000)
    return false;
  obs_enter_graphics();
  bool ok = p->pending && p->prepared_revision == revision &&
            p->pending_media_count < 24;
  if (ok)
    p->pending_media[p->pending_media_count++] =
        (struct media_clock){media, playing, position};
  obs_leave_graphics();
  return ok;
}
bool producer_set_v2_program_shader(obs_source_t *s, uint64_t revision,
                                    obs_source_t *shader, float intensity,
                                    float scale, float opacity, double base,
                                    bool running) {
  struct program *p = get(s);
  if (!p || !shader ||
      strcmp(obs_source_get_id(shader), "producer_shader_layer") ||
      !isfinite(intensity) || intensity < 0 || intensity > 2 ||
      !isfinite(scale) || scale < .25f || scale > 4 || !isfinite(opacity) ||
      opacity < 0 || opacity > 1 || !isfinite(base) || base < 0 ||
      base > 86400000)
    return false;
  obs_enter_graphics();
  bool ok = p->pending && p->prepared_revision == revision &&
            p->pending_effect_count < 32;
  if (ok)
    p->pending_effects[p->pending_effect_count++] = (struct effect_clock){
        shader, intensity, scale, opacity, base, p->clock_ms, running};
  obs_leave_graphics();
  return ok;
}

bool producer_set_v2_program_track(
    obs_source_t *s, uint64_t revision, struct producer_set_v2_scene *scene,
    const char *target, obs_source_t *shader, int property,
    const struct producer_set_v2_keyframe *frames, size_t count, int easing,
    int loop, double base, double delay, bool running) {
  struct program *p = get(s);
  if (!p || !scene || !target || strlen(target) > 64 ||
      !producer_set_v2_scene_node(scene, target) || property < 0 ||
      property > 9 || !frames || count < 2 || count > 64 || easing < 0 ||
      easing > 3 || loop < 0 || loop > 2 || !isfinite(base) || base < 0 ||
      base > 86400000 || !isfinite(delay) || delay < 0 || delay > 60000)
    return false;
  for (size_t i = 0; i < count; i++) {
    float v = frames[i].value;
    double at = frames[i].at_ms;
    if (!isfinite(at) || at < 0 || at > 60000 || (!i && at != 0) ||
        (i && at <= frames[i - 1].at_ms) || !isfinite(v) || fabsf(v) > 36000)
      return false;
    if (((property == 4 || property == 9) && (v < 0 || v > 1)) ||
        (property == 6 && (v < .01f || v > 32)) ||
        (property == 7 && (v < 0 || v > 2)) ||
        (property == 8 && (v < .25f || v > 4)) ||
        ((property == 2 || property == 3) && (v < 0 || v > 8192)))
      return false;
  }
  if ((property == 7 || property == 8) &&
      (!shader || strcmp(obs_source_get_id(shader), "producer_shader_layer")))
    return false;
  obs_enter_graphics();
  bool ok = p->pending && p->prepared_revision == revision &&
            p->pending_track_count < 128;
  if (ok) {
    struct motion_track *t = &p->pending_tracks[p->pending_track_count++];
    memset(t, 0, sizeof(*t));
    t->scene = scene;
    snprintf(t->target, sizeof(t->target), "%s", target);
    t->shader = shader;
    t->property = property;
    t->easing = easing;
    t->loop = loop;
    t->base_ms = base;
    t->delay_ms = delay;
    t->running = running;
    t->anchor_ms = p->clock_ms;
    t->count = count;
    memcpy(t->frames, frames, count * sizeof(*frames));
  }
  obs_leave_graphics();
  return ok;
}

void producer_set_v2_program_stop_motion(obs_source_t *source) {
  struct program *p = get(source);
  if (!p) return;
  obs_enter_graphics();
  p->track_count = p->pending_track_count = p->retired_track_count = 0;
  obs_leave_graphics();
}

/* Only the owner may promote a previously painted, warmed retained scene. */
bool producer_set_v2_program_cached_ready(obs_source_t *s,uint64_t revision){
  struct program *p=get(s);if(!p)return false;
  obs_enter_graphics();bool ok=p->pending&&p->prepared_revision==revision;
  if(ok){p->ready=true;p->warmed=true;}obs_leave_graphics();return ok;
}

bool producer_set_v2_program_chart(obs_source_t*s,uint64_t revision,obs_source_t*chart){struct program*p=get(s);if(!p||!chart||!producer_chart_key(chart)[0])return false;obs_enter_graphics();bool ok=p->pending&&p->prepared_revision==revision&&p->pending_chart_count<4;if(ok)p->pending_charts[p->pending_chart_count++]=chart;obs_leave_graphics();return ok;}
