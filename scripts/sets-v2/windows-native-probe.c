/* D3D11 pixel proof. Runs beside an installed engine without touching rooms,
 * devices, credentials, streaming destinations, or the installed executable. */
#include "sets_v2/group.h"
#include "sets_v2/chart.h"
#include "sets_v2/scene.h"
#include "sets_v2/program.h"
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct video_info {
  const char *graphics_module;
  uint32_t fps_num, fps_den, base_width, base_height, output_width, output_height;
  int output_format;
  uint32_t adapter;
  bool gpu_conversion;
  int colorspace, range, scale_type;
};
OBS_IMPORT bool obs_startup(const char *, const char *, void *);
OBS_IMPORT int obs_reset_video(struct video_info *);
OBS_IMPORT void obs_add_data_path(const char *);
OBS_IMPORT void obs_shutdown(void);
OBS_IMPORT void obs_set_output_source(uint32_t, obs_source_t *);
OBS_IMPORT bool obs_wait_for_destroy_queue(void);
OBS_IMPORT void *obs_canvas_create_private(const char *, struct video_info *, uint32_t);
OBS_IMPORT void *obs_canvas_get_video(const void *);
OBS_IMPORT void obs_canvas_remove(void *);
OBS_IMPORT void obs_canvas_release(void *);
OBS_IMPORT int video_output_get_width(const void *);
OBS_IMPORT int video_output_get_height(const void *);
OBS_IMPORT obs_data_t *obs_data_create(void);
OBS_IMPORT void obs_data_set_double(obs_data_t *, const char *, double);

static void require(bool ok, const char *message) {
  if (!ok) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}
struct solid { float r, g, b; gs_effect_t *effect; };
static const char *name(void *p) { (void)p; return "Windows pixel proof"; }
static uint32_t width(void *p) { (void)p; return 320; }
static uint32_t height(void *p) { (void)p; return 240; }
static void *create(obs_data_t *d, obs_source_t *s) {
  (void)s;
  struct solid *p = calloc(1, sizeof(*p));
  if (!p) return NULL;
  p->r = (float)obs_data_get_double(d, "r");
  p->g = (float)obs_data_get_double(d, "g");
  p->b = (float)obs_data_get_double(d, "b");
  obs_enter_graphics();
  char *error = NULL;
  p->effect = gs_effect_create(
    "uniform float4x4 ViewProj;uniform float4 tint;"
    "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};"
    "V VS(V v){V o;o.pos=mul(float4(v.pos.xyz,1),ViewProj);o.uv=v.uv;return o;}"
    "float4 PS(V v):TARGET{return tint;}"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}",
    "windows-proof", &error);
  if (error) { fprintf(stderr, "%s\n", error); bfree(error); }
  obs_leave_graphics();
  require(p->effect != NULL, "D3D11 solid shader");
  return p;
}
static void destroy(void *data) {
  struct solid *p = data;
  obs_enter_graphics(); gs_effect_destroy(p->effect); obs_leave_graphics(); free(p);
}
static void render(void *data, gs_effect_t *ignored) {
  (void)ignored;
  struct solid *p = data;
  struct vec4 tint = {p->r, p->g, p->b, 1};
  gs_effect_set_vec4(gs_effect_get_param_by_name(p->effect, "tint"), &tint);
  gs_technique_t *t = gs_effect_get_technique(p->effect, "Draw");
  size_t n = gs_technique_begin(t);
  for (size_t i = 0; i < n; i++) if (gs_technique_begin_pass(t, i)) {
    gs_draw_sprite(NULL, 0, 320, 240); gs_technique_end_pass(t);
  }
  gs_technique_end(t);
}
static obs_source_t *solid(float r, float g, float b) {
  obs_data_t *d = obs_data_create();
  obs_data_set_double(d, "r", r); obs_data_set_double(d, "g", g); obs_data_set_double(d, "b", b);
  obs_source_t *s = obs_source_create_private("windows_pixel_proof", "Proof", d);
  obs_data_release(d); require(s != NULL, "solid source"); return s;
}
static uint8_t *capture(obs_source_t *s, bool linear) {
  const uint32_t w = 320, h = 240;
  obs_enter_graphics();
  gs_texrender_t *t = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  gs_stagesurf_t *stage = gs_stagesurface_create(w, h, GS_RGBA);
  require(t && stage && gs_texrender_begin(t, w, h), "D3D11 render target");
  struct vec4 clear = {0}; gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
  gs_ortho(0, w, 0, h, -100, 100); gs_matrix_push(); gs_matrix_identity();
  gs_blend_state_push(); gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  bool prev = gs_set_linear_srgb(linear), fb = gs_framebuffer_srgb_enabled();
  gs_enable_framebuffer_srgb(linear); obs_source_video_render(s);
  require(gs_get_linear_srgb() == linear && gs_framebuffer_srgb_enabled() == linear, "restore color state");
  gs_enable_framebuffer_srgb(fb); gs_set_linear_srgb(prev);
  gs_blend_state_pop(); gs_matrix_pop(); gs_texrender_end(t);
  gs_stage_texture(stage, gs_texrender_get_texture(t));
  uint8_t *mapped = NULL; uint32_t stride = 0;
  require(gs_stagesurface_map(stage, &mapped, &stride), "D3D11 readback");
  uint8_t *pixels = malloc(w * h * 4); require(pixels != NULL, "pixel buffer");
  for (uint32_t y = 0; y < h; y++) memcpy(pixels + y*w*4, mapped + y*stride, w*4);
  gs_stagesurface_unmap(stage); gs_stagesurface_destroy(stage); gs_texrender_destroy(t);
  obs_leave_graphics(); return pixels;
}
static uint8_t *pixel(uint8_t *p, int x, int y) { return p + (y*320+x)*4; }
static void add(obs_source_t *g, obs_source_t *s, float x, float y, float w, float h) {
  require(producer_set_v2_group_add(g, s, x, y, w, h, false), "ordered layer");
}
int main(int argc, char **argv) {
  require(argc == 3, "usage: probe ENGINE_DIRECTORY CONFIG_DIRECTORY");
  require(obs_startup("en-US", argv[2], NULL), "OBS startup");
  char path[4096]; snprintf(path, sizeof(path), "%s/data/libobs/", argv[1]); obs_add_data_path(path);
  snprintf(path, sizeof(path), "%s/libobs-d3d11.dll", argv[1]);
  struct video_info vi = {path, 30, 1, 320, 240, 320, 240, 2, 0, true, 2, 0, 3};
  require(obs_reset_video(&vi) == 0, "D3D11 video startup");
  struct obs_source_info si = {0};
  si.id = "windows_pixel_proof"; si.type = OBS_SOURCE_TYPE_INPUT;
  si.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  si.get_name = name; si.create = create; si.destroy = destroy;
  si.get_width = width; si.get_height = height; si.video_render = render;
  obs_register_source_s(&si, sizeof(si));
  producer_set_v2_register(); producer_chart_register();
  producer_set_v2_transition_register(); producer_set_v2_program_register();
  obs_source_t *red = solid(1,0,0), *blue = solid(0,0,1), *green = solid(0,1,0);
  obs_source_t *mask = producer_set_v2_group_create(320,240,0,1);
  require(mask && producer_set_v2_group_effects(mask,2,.5,.5,.5,0,false,0,0), "wipe shader");
  add(mask,red,0,0,320,240); require(producer_set_v2_group_seal(mask), "seal mask");
  uint8_t *p = capture(mask,false);
  require(pixel(p,40,120)[0] > 245 && pixel(p,40,120)[3] == 255 && pixel(p,280,120)[3] == 0, "wipe pixels"); free(p);
  puts("PASS: native mask@1 D3D11 pixels");
  obs_source_t *panel = producer_set_v2_group_create(200,160,12,1);
  require(panel && producer_set_v2_group_effects(panel,0,1,.5,.5,0,false,0,20), "backdrop shader");
  add(panel,green,88,68,24,24); require(producer_set_v2_group_seal(panel), "seal backdrop");
  obs_source_t *root = producer_set_v2_group_create(320,240,0,1);
  add(root,red,0,0,320,240); add(root,blue,160,0,160,240); add(root,panel,60,40,200,160);
  require(producer_set_v2_group_seal(root), "seal scene");
  for (int linear=0;linear<2;linear++) {
    p = capture(root,linear);
    require(pixel(p,159,70)[0]>30 && pixel(p,159,70)[2]>30, "blur samples prior siblings");
    require(pixel(p,159,15)[0]>245 && pixel(p,159,15)[2]<10, "outside backdrop stays sharp");
    require(pixel(p,160,120)[1]>245 && pixel(p,160,120)[0]<10, "foreground stays sharp"); free(p);
  }
  puts("PASS: native backdrop@1 D3D11 pixels, both color modes");
  struct producer_chart_point points[] = {{0,0,true},{1,1,true},{2,0,true}};
  struct producer_chart_spec spec = {"proof","windows",0,0,2,0,1,0xFF00FF00,0,0,4,.3f,points,3};
  for (int kind=0;kind<3;kind++) {
    spec.kind=kind; obs_source_t *chart=producer_chart_create(320,240,&spec); require(chart!=NULL,"chart source");
    p=capture(chart,false); size_t count=0; for(size_t i=0;i<320*240;i++) if(p[i*4+3]>0) count++;
    require(count>100,"chart geometry paints pixels"); free(p); obs_source_release(chart);
  }
  puts("PASS: native chart@1 line, area and bar D3D11 pixels");
  struct producer_set_v2_node leaf = {.id="video",.kind=SET_V2_SURFACE,.width=320,.height=240,.opacity=1,.visible=true,.surface=red,.mask_progress=1};
  struct producer_set_v2_node reveal = {.id="reveal",.kind=SET_V2_GROUP,.width=320,.height=240,.opacity=1,.visible=true,.children=&leaf,.child_count=1,.mask_kind=2,.mask_progress=1,.mask_x=.5,.mask_y=.5};
  char error[256]={0};
  struct producer_set_v2_scene *scene=producer_set_v2_scene_prepare(&reveal,320,240,SET_V2_STRETCH,32*1024*1024,error,sizeof(error));
  require(scene!=NULL,"native scene preparation");
  obs_source_t *program=producer_set_v2_program_create(320,240);
  require(program && producer_set_v2_program_prepare(program,producer_set_v2_scene_source(scene),1),"program prepare");
  struct producer_set_v2_keyframe frames[]={{0,0},{1200,1}};
  require(producer_set_v2_program_track(program,1,scene,"reveal",NULL,9,frames,2,3,0,600,0,false),"mask animation track");
  require(producer_set_v2_program_cached_ready(program,1) && producer_set_v2_program_take(program,1,0,PRODUCER_SET_V2_DISSOLVE),"program take");
  p=capture(program,false);
  require(pixel(p,40,120)[3]==255 && pixel(p,280,120)[3]==0,"paused native animation midpoint"); free(p);
  producer_set_v2_program_stop_motion(program); obs_source_release(program);
  producer_set_v2_scene_reset(scene); Sleep(50); p=capture(producer_set_v2_scene_source(scene),false);
  require(pixel(p,280,120)[3]==255,"cached scene reset"); free(p); producer_set_v2_scene_release(scene);
  puts("PASS: native scene preparation, take, paused animation and reset");
  vi.base_width=240; vi.base_height=320; vi.output_width=240; vi.output_height=320;
  void *canvas=obs_canvas_create_private("Windows portrait proof",&vi,2|8|16);
  require(canvas!=NULL,"private portrait canvas"); void *video=obs_canvas_get_video(canvas);
  require(video && video_output_get_width(video)==240 && video_output_get_height(video)==320,"portrait video dimensions");
  obs_canvas_remove(canvas); obs_canvas_release(canvas); puts("PASS: native portrait canvas 240 x 320");
  for (int i=0;i<60;i++) { obs_set_output_source(0,root); Sleep(2); obs_set_output_source(0,NULL); }
  obs_source_release(root); obs_source_release(panel); obs_source_release(mask);
  obs_source_release(red); obs_source_release(blue); obs_source_release(green);
  for(int i=0;i<300 && (producer_set_v2_live_groups() || producer_chart_live_count() || producer_set_v2_live_programs());i++) {
    obs_wait_for_destroy_queue(); Sleep(10);
  }
  require(producer_set_v2_live_groups()==0 && producer_chart_live_count()==0 && producer_set_v2_live_programs()==0,"native resources released");
  obs_shutdown(); puts("PASS: native scene lifetime and cleanup"); return 0;
}
