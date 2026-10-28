#include "chart.h"
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define ID "producer_set_v2_chart"
#define LIMIT 256
OBS_IMPORT void gs_render_start(bool);
typedef struct gs_vertex_buffer gs_vertbuffer_t;
OBS_IMPORT gs_vertbuffer_t *gs_render_save(void);
OBS_IMPORT void gs_vertexbuffer_destroy(gs_vertbuffer_t *);
OBS_IMPORT void gs_load_vertexbuffer(gs_vertbuffer_t *);
OBS_IMPORT void gs_load_indexbuffer(void *);
OBS_IMPORT void gs_draw(int, uint32_t, uint32_t);
OBS_IMPORT void gs_vertex2f(float, float);
OBS_IMPORT void gs_color(uint32_t);
struct chart {
  uint32_t w, h;
  char id[65], scope[121];
  int kind;
  double domain[4], from_domain[4], start, clock;
  float duration, width, fill;
  uint32_t color, grid;
  struct producer_chart_point points[LIMIT], from[LIMIT];
  size_t count, from_count;
  gs_effect_t *effect;
  gs_vertbuffer_t *vertices;
  double painted_progress;
  bool dirty;
  size_t builds;
};
static atomic_size_t live_charts;
size_t producer_chart_live_count(void) { return atomic_load(&live_charts); }
static const char *CODE =
    "uniform float4x4 ViewProj;struct V{float4 pos:POSITION;float4 "
    "color:COLOR;};V VS(V v){V "
    "o;o.pos=mul(float4(v.pos.xyz,1),ViewProj);o.color=v.color;return "
    "o;}float4 PS(V v):TARGET{return v.color;}technique "
    "Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}";
static struct chart *get(obs_source_t *s) {
  return s && !strcmp(obs_source_get_id(s), ID) ? obs_obj_get_data(s) : NULL;
}
size_t producer_chart_geometry_builds(obs_source_t *s) {
  struct chart *c = get(s);
  return c ? c->builds : 0;
}
const char *producer_chart_key(obs_source_t *s) {
  struct chart *c = get(s);
  return c ? c->id : "";
}
static const char *name(void *p) {
  (void)p;
  return "Producer live chart";
}
static uint32_t width(void *p) { return ((struct chart *)p)->w; }
static uint32_t height(void *p) { return ((struct chart *)p)->h; }
static void *create(obs_data_t *d, obs_source_t *s) {
  (void)s;
  double w = obs_data_get_double(d, "width"),
         h = obs_data_get_double(d, "height");
  if (!isfinite(w) || !isfinite(h) || w < 1 || h < 1 || w > 4096 || h > 4096)
    return NULL;
  struct chart *c = calloc(1, sizeof(*c));
  if (!c)
    return NULL;
  c->w = w;
  c->h = h;
  char *error = NULL;
  obs_enter_graphics();
  c->effect = gs_effect_create(CODE, "producer-chart.effect", &error);
  obs_leave_graphics();
  if (error) {
    blog(LOG_ERROR, "[chart] %s", error);
    bfree(error);
  }
  if (!c->effect) {
    free(c);
    return NULL;
  }
  atomic_fetch_add(&live_charts, 1);
  return c;
}
static void destroy(void *p) {
  struct chart *c = p;
  if (!c)
    return;
  obs_enter_graphics();
  gs_effect_destroy(c->effect);
  if (c->vertices)
    gs_vertexbuffer_destroy(c->vertices);
  obs_leave_graphics();
  free(c);
  atomic_fetch_sub(&live_charts, 1);
}
static double lerp(double a, double b, double p) { return a + (b - a) * p; }
static double progress(struct chart *c) {
  double p = c->duration > 0
                 ? fmin(1, fmax(0, (c->clock - c->start) / c->duration))
                 : 1;
  return p * p * (3 - 2 * p);
}
static bool sample(const struct producer_chart_point *p, size_t n, double x,
                   double *y) {
  if (!n || x < p[0].x || x > p[n - 1].x)
    return false;
  size_t a = 0, b = n - 1;
  while (b > a + 1) {
    size_t m = (a + b) / 2;
    if (p[m].x <= x)
      a = m;
    else
      b = m;
  }
  if (p[a].x == x) {
    *y = p[a].y;
    return p[a].valid;
  }
  if (p[b].x == x) {
    *y = p[b].y;
    return p[b].valid;
  }
  if (!p[a].valid || !p[b].valid || p[b].x <= p[a].x)
    return false;
  *y = lerp(p[a].y, p[b].y, (x - p[a].x) / (p[b].x - p[a].x));
  return true;
}
static bool display(struct chart *c, double x, double p, double *y,
                    float *alpha) {
  double a = 0, b = 0;
  bool av = sample(c->from, c->from_count, x, &a),
       bv = sample(c->points, c->count, x, &b);
  *alpha = av && bv ? 1 : av ? 1 - p : bv ? p : 0;
  if (!av && !bv)
    return false;
  *y = av && bv ? lerp(a, b, p) : bv ? b : a;
  return true;
}
void producer_chart_frame(obs_source_t *s, double clock) {
  struct chart *c = get(s);
  if (c && isfinite(clock))
    c->clock = clock;
}
void producer_chart_begin(obs_source_t *s, obs_source_t *old, double clock) {
  struct chart *c = get(s), *prev = get(old);
  if (!c || c == prev)
    return;
  c->clock = c->start = clock;
  c->dirty = true;
  if (prev && !strcmp(c->scope, prev->scope) && !strcmp(c->id, prev->id)) {
    prev->clock = clock;
    double p = progress(prev);
    for (int i = 0; i < 4; i++)
      c->from_domain[i] = lerp(prev->from_domain[i], prev->domain[i], p);
    c->from_count = LIMIT;
    for (int i = 0; i < LIMIT; i++) {
      double x = lerp(c->from_domain[0], c->from_domain[1],
                      (double)i / (LIMIT - 1)),
             y = 0;
      float alpha = 0;
      bool valid = display(prev, x, p, &y, &alpha);
      c->from[i] = (struct producer_chart_point){x, y, valid && alpha > .01f};
    }
  } else {
    memcpy(c->from, c->points, sizeof(c->points));
    c->from_count = c->count;
    memcpy(c->from_domain, c->domain, sizeof(c->domain));
    c->start = clock - c->duration;
  }
}
static void vertex(float x, float y, uint32_t rgb, float alpha) {
  float a = ((rgb >> 24) & 255) / 255.f * alpha;
  uint32_t r = (uint32_t)lroundf((rgb & 255) * a),
           g = (uint32_t)lroundf(((rgb >> 8) & 255) * a),
           b = (uint32_t)lroundf(((rgb >> 16) & 255) * a),
           opacity = (uint32_t)lroundf(a * 255);
  gs_color(r | (g << 8) | (b << 16) | (opacity << 24));
  gs_vertex2f(x, y);
}
static void triangle(float x1, float y1, float x2, float y2, float x3, float y3,
                     uint32_t color, float a1, float a2, float a3) {
  vertex(x1, y1, color, a1);
  vertex(x2, y2, color, a2);
  vertex(x3, y3, color, a3);
}
static void rect(float x, float y, float w, float h, uint32_t color,
                 float alpha) {
  triangle(x, y, x + w, y, x + w, y + h, color, alpha, alpha, alpha);
  triangle(x, y, x + w, y + h, x, y + h, color, alpha, alpha, alpha);
}
static void render(void *p, gs_effect_t *unused) {
  (void)unused;
  struct chart *c = p;
  if (!c->effect)
    return;
  double t = progress(c), domain[4];
  for (int i = 0; i < 4; i++)
    domain[i] = lerp(c->from_domain[i], c->domain[i], t);
  bool linear = gs_get_linear_srgb(), fb = gs_framebuffer_srgb_enabled();
  gs_set_linear_srgb(false);
  gs_enable_framebuffer_srgb(false);
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  gs_technique_t *tech = gs_effect_get_technique(c->effect, "Draw");
  size_t passes = gs_technique_begin(tech);
  for (size_t pass = 0; pass < passes; pass++)
    if (gs_technique_begin_pass(tech, pass)) {
      if (!c->vertices || c->dirty || c->painted_progress != t) {
        gs_render_start(true);
        for (int i = 0; i < 5; i++)
          rect(0, (c->h - 1) * i / 4.f, c->w, 1, c->grid, 1);
        if (c->kind == 2) {
          for (size_t i = 0; i < c->count; i++) {
            double y;
            float alpha;
            double x = c->points[i].x;
            if (!display(c, x, t, &y, &alpha))
              continue;
            float px = (x - domain[0]) / (domain[1] - domain[0]) * c->w,
                  h = fmin(1,
                           fmax(0, (y - domain[2]) / (domain[3] - domain[2]))) *
                      (c->h - 2);
            float w = fmax(1, c->w / fmax(1, c->count) * .62);
            if (px < 0 || px > c->w)
              continue;
            float left = fmax(0, px - w / 2), right = fmin(c->w, px + w / 2);
            rect(left, c->h - 1 - h, right - left, h, c->color, alpha * .75);
          }
        } else {
          float lastx = 0, lasty = 0, lasta = 0;
          bool last = false;
          for (int i = 0; i < LIMIT; i++) {
            double x = lerp(domain[0], domain[1], (double)i / (LIMIT - 1)), y;
            float a;
            bool valid = display(c, x, t, &y, &a);
            float px = (float)i / (LIMIT - 1) * c->w, py = 0;
            if (valid)
              py = (1 - fmin(1, fmax(0, (y - domain[2]) /
                                            (domain[3] - domain[2])))) *
                       (c->h - 2) +
                   1;
            if (valid && last) {
              if (c->kind == 1) {
                triangle(lastx, lasty, px, py, px, c->h, c->color,
                         lasta * c->fill, a * c->fill, 0);
                triangle(lastx, lasty, px, c->h, lastx, c->h, c->color,
                         lasta * c->fill, 0, 0);
              }
              float dx = px - lastx, dy = py - lasty,
                    len = fmaxf(.001f, hypotf(dx, dy)),
                    nx = -dy / len * c->width / 2, ny = dx / len * c->width / 2;
              triangle(lastx + nx, lasty + ny, px + nx, py + ny, px - nx,
                       py - ny, c->color, lasta, a, a);
              triangle(lastx + nx, lasty + ny, px - nx, py - ny, lastx - nx,
                       lasty - ny, c->color, lasta, a, lasta);
            }
            last = valid;
            lastx = px;
            lasty = py;
            lasta = a;
          }
        }
        gs_vertbuffer_t *next = gs_render_save();
        if (c->vertices)
          gs_vertexbuffer_destroy(c->vertices);
        c->vertices = next;
        c->painted_progress = t;
        c->builds++;
        c->dirty = false;
      }
      gs_load_vertexbuffer(c->vertices);
      gs_load_indexbuffer(NULL);
      gs_draw(3, 0, 0);
      gs_technique_end_pass(tech);
    }
  gs_technique_end(tech);
  gs_blend_state_pop();
  gs_set_linear_srgb(linear);
  gs_enable_framebuffer_srgb(fb);
}
void producer_chart_register(void) {
  struct obs_source_info i = {0};
  i.id = ID;
  i.type = OBS_SOURCE_TYPE_INPUT;
  i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
  i.get_name = name;
  i.create = create;
  i.destroy = destroy;
  i.get_width = width;
  i.get_height = height;
  i.video_render = render;
  obs_register_source_s(&i, sizeof(i));
}
obs_source_t *producer_chart_create(uint32_t w, uint32_t h,
                                    const struct producer_chart_spec *s) {
  if (!s || !s->id || !s->scope || strlen(s->id) > 64 ||
      strlen(s->scope) > 120 || s->count > LIMIT || (s->count && !s->points) ||
      s->kind < 0 || s->kind > 2 || !isfinite(s->x_min) ||
      !isfinite(s->x_max) || !isfinite(s->y_min) || !isfinite(s->y_max) ||
      s->x_max <= s->x_min || s->y_max <= s->y_min ||
      !isfinite(s->duration_ms) || s->duration_ms < 0 ||
      s->duration_ms > 2000 || !isfinite(s->line_width) || s->line_width < 1 ||
      s->line_width > 8 || !isfinite(s->fill_opacity) || s->fill_opacity < 0 ||
      s->fill_opacity > .5)
    return NULL;
  for (size_t i = 0; i < s->count; i++)
    if (!isfinite(s->points[i].x) || fabs(s->points[i].x) > 1e15 ||
        !isfinite(s->points[i].y) || fabs(s->points[i].y) > 1e6 ||
        (i && s->points[i].x <= s->points[i - 1].x))
      return NULL;
  char json[100];
  snprintf(json, sizeof(json), "{\"width\":%u,\"height\":%u}", w, h);
  obs_data_t *d = obs_data_create_from_json(json);
  obs_source_t *out = obs_source_create_private(ID, "Set live chart", d);
  obs_data_release(d);
  struct chart *c = get(out);
  if (!c) {
    if (out)
      obs_source_release(out);
    return NULL;
  }
  strcpy(c->id, s->id);
  strcpy(c->scope, s->scope);
  c->kind = s->kind;
  c->domain[0] = s->x_min;
  c->domain[1] = s->x_max;
  c->domain[2] = s->y_min;
  c->domain[3] = s->y_max;
  memcpy(c->from_domain, c->domain, sizeof(c->domain));
  c->count = c->from_count = s->count;
  if (s->count) {
    memcpy(c->points, s->points, s->count * sizeof(*s->points));
    memcpy(c->from, c->points, s->count * sizeof(*s->points));
  }
  c->duration = s->duration_ms;
  c->width = s->line_width;
  c->fill = s->fill_opacity;
  c->color = s->color;
  c->grid = s->grid_color;
  c->start = -s->duration_ms;
  return out;
}
