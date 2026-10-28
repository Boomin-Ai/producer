#ifndef PRODUCER_SET_V2_CHART_H
#define PRODUCER_SET_V2_CHART_H
#include "../obs_min.h"
struct producer_chart_point {
  double x, y;
  bool valid;
};
struct producer_chart_spec {
  const char *id, *scope;
  int kind;
  double x_min, x_max, y_min, y_max;
  uint32_t color, grid_color;
  float duration_ms, line_width, fill_opacity;
  const struct producer_chart_point *points;
  size_t count;
};
void producer_chart_register(void);
size_t producer_chart_live_count(void);
size_t producer_chart_geometry_builds(obs_source_t *source);
obs_source_t *producer_chart_create(uint32_t w, uint32_t h,
                                    const struct producer_chart_spec *spec);
/* Graphics thread only. Copies displayed state; never retains the old source.
 */
void producer_chart_begin(obs_source_t *next, obs_source_t *previous,
                          double clock_ms);
void producer_chart_frame(obs_source_t *source, double clock_ms);
const char *producer_chart_key(obs_source_t *source);
#endif
