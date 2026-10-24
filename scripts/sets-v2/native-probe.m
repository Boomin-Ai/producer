/* Isolated libobs pixel probe. No camera, microphone, network, room, encoders
 * or outputs. The synthetic capture is a real live libobs source, not a bitmap
 * camera placeholder. */
#include "sets_v2/group.h"
#include "sets_v2/program.h"
#include "sets_v2/scene.h"
#include "sets_v2/transition.h"
#import <AppKit/AppKit.h>
#import <Metal/Metal.h>
#include <math.h>
#import <objc/runtime.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
OBS_IMPORT bool obs_startup(const char *, const char *, void *);
OBS_IMPORT void obs_set_cmdline_args(int, const char *const *);
OBS_IMPORT void obs_set_ui_task_handler(void (*)(void (*)(void *), void *,
                                                 bool));
OBS_IMPORT void obs_shutdown(void);
OBS_IMPORT bool obs_wait_for_destroy_queue(void);
OBS_IMPORT int obs_open_module(void **, const char *, const char *);
OBS_IMPORT bool obs_init_module(void *);
OBS_IMPORT void obs_post_load_modules(void);
OBS_IMPORT void obs_source_set_audio_mixers(obs_source_t *, uint32_t);
OBS_IMPORT void obs_add_data_path(const char *);
OBS_IMPORT const char *obs_get_version_string(void);
OBS_IMPORT void obs_set_output_source(uint32_t, obs_source_t *);
typedef struct obs_scene obs_scene_t;
typedef struct obs_scene_item obs_sceneitem_t;
OBS_IMPORT obs_scene_t *obs_scene_create_private(const char *);
OBS_IMPORT obs_source_t *obs_scene_get_source(const obs_scene_t *);
OBS_IMPORT obs_sceneitem_t *obs_scene_add(obs_scene_t *, obs_source_t *);
OBS_IMPORT void obs_scene_release(obs_scene_t *);
extern void sets_v2_rust_register(void);
extern void producer_source_appearance_register(void);
extern void *sets_v2_rust_attach(obs_scene_t *, uint32_t, uint32_t);
extern bool sets_v2_rust_dispatch(void *, const char *, obs_source_t *, char *,
                                  size_t);
extern void sets_v2_rust_release(void *);

OBS_IMPORT void obs_source_inc_active(obs_source_t *);
OBS_IMPORT void obs_source_dec_active(obs_source_t *);
OBS_IMPORT void obs_source_inc_showing(obs_source_t *);
OBS_IMPORT bool obs_source_showing(const obs_source_t *);
OBS_IMPORT bool obs_source_active(const obs_source_t *);
OBS_IMPORT void obs_source_dec_showing(obs_source_t *);
OBS_IMPORT void gs_matrix_scale3f(float, float, float);
struct video_info {
  const char *graphics_module;
  uint32_t fps_num, fps_den, base_width, base_height, output_width,
      output_height;
  int output_format;
  uint32_t adapter;
  bool gpu_conversion;
  int colorspace, range, scale_type;
};
OBS_IMPORT int obs_reset_video(struct video_info *);
struct probe_audio_info {
  uint32_t samples_per_sec;
  int speakers;
};
OBS_IMPORT bool obs_reset_audio(const struct probe_audio_info *);
struct test_source {
  uint32_t w, h;
  float r, g, b, time;
  bool animated;
  gs_effect_t *effect;
};
static const char CODE[] =
    "uniform float4x4 ViewProj;uniform float4 tint;uniform float phase;uniform "
    "float live;"
    "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};V VS(V v){V "
    "o;o.pos=mul(float4(v.pos.xyz,1),ViewProj);o.uv=v.uv;return o;}"
    "float4 PS(V v):TARGET{float "
    "marker=step(abs(v.uv.x-frac(phase)),0.06)*step(v.uv.y,0.18)*live;return "
    "lerp(tint,float4(1,1,1,1),marker);}"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}";
static atomic_uint source_live = 0;
static const char *test_name(void *x) {
  (void)x;
  return "Synthetic moving capture";
}
static uint32_t tw(void *x) { return ((struct test_source *)x)->w; }
static uint32_t th(void *x) { return ((struct test_source *)x)->h; }
static void *test_create(obs_data_t *s, obs_source_t *source) {
  (void)source;
  struct test_source *t = calloc(1, sizeof(*t));
  t->w = obs_data_get_double(s, "width");
  t->h = obs_data_get_double(s, "height");
  t->r = obs_data_get_double(s, "r");
  t->g = obs_data_get_double(s, "g");
  t->b = obs_data_get_double(s, "b");
  t->animated = obs_data_get_double(s, "live") > 0;
  char *e = NULL;
  obs_enter_graphics();
  t->effect = gs_effect_create(CODE, "sets-v2-probe.effect", &e);
  obs_leave_graphics();
  if (e) {
    fprintf(stderr, "effect: %s\n", e);
    bfree(e);
  }
  if (!t->effect) {
    free(t);
    return NULL;
  }
  atomic_fetch_add(&source_live, 1);
  return t;
}
static void test_destroy(void *x) {
  struct test_source *t = x;
  obs_enter_graphics();
  gs_effect_destroy(t->effect);
  obs_leave_graphics();
  free(t);
  atomic_fetch_sub(&source_live, 1);
}
static void test_tick(void *x, float seconds) {
  ((struct test_source *)x)->time += seconds;
}
static void test_draw(void *x, gs_effect_t *unused) {
  (void)unused;
  struct test_source *t = x;
  struct vec4 tint = {t->r, t->g, t->b, 1};
  gs_effect_set_vec4(gs_effect_get_param_by_name(t->effect, "tint"), &tint);
  gs_effect_set_float(gs_effect_get_param_by_name(t->effect, "phase"), t->time);
  gs_effect_set_float(gs_effect_get_param_by_name(t->effect, "live"),
                      t->animated ? 1 : 0);
  gs_technique_t *tech = gs_effect_get_technique(t->effect, "Draw");
  size_t n = gs_technique_begin(tech);
  for (size_t i = 0; i < n; i++)
    if (gs_technique_begin_pass(tech, i)) {
      gs_draw_sprite(NULL, 0, t->w, t->h);
      gs_technique_end_pass(tech);
    }
  gs_technique_end(tech);
}
static void register_test(void) {
  struct obs_source_info i = {0};
  i.id = "sets_v2_probe_color";
  i.type = OBS_SOURCE_TYPE_INPUT;
  i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW;
  i.get_name = test_name;
  i.create = test_create;
  i.destroy = test_destroy;
  i.get_width = tw;
  i.get_height = th;
  i.video_tick = test_tick;
  i.video_render = test_draw;
  obs_register_source_s(&i, sizeof(i));
}
static obs_source_t *solid(uint32_t w, uint32_t h, float r, float g, float b,
                           bool live) {
  char json[240];
  snprintf(
      json, sizeof(json),
      "{\"width\":%u,\"height\":%u,\"r\":%g,\"g\":%g,\"b\":%g,\"live\":%d}", w,
      h, r, g, b, live);
  obs_data_t *d = obs_data_create_from_json(json);
  obs_source_t *s =
      obs_source_create_private("sets_v2_probe_color", "Proof source", d);
  obs_data_release(d);
  if (!s) {
    fprintf(stderr, "source failed\n");
    exit(2);
  }
  return s;
}
static bool add(obs_source_t *g, obs_source_t *s, float x, float y, float w,
                float h) {
  return producer_set_v2_group_add(g, s, x, y, w, h, false);
}
static void require(bool condition, const char *message) {
  if (!condition) {
    fprintf(stderr, "FAIL: %s\n", message);
    exit(3);
  }
}
static NSData *capture(obs_source_t *source, uint32_t designW, uint32_t designH,
                       uint32_t outW, uint32_t outH) {
  obs_enter_graphics();
  gs_texrender_t *target = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
  gs_stagesurf_t *stage = gs_stagesurface_create(outW, outH, GS_RGBA);
  require(target && stage, "allocate readback");
  require(gs_texrender_begin(target, outW, outH), "begin readback");
  struct vec4 clear = {0, 0, 0, 0};
  gs_clear(GS_CLEAR_COLOR, &clear, 0, 0);
  gs_ortho(0, designW, 0, designH, -100, 100);
  gs_matrix_push();
  gs_matrix_identity();
  gs_blend_state_push();
  gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
  obs_source_video_render(source);
  gs_blend_state_pop();
  gs_matrix_pop();
  gs_texrender_end(target);
  gs_stage_texture(stage, gs_texrender_get_texture(target));
  uint8_t *p = NULL;
  uint32_t stride = 0;
  require(gs_stagesurface_map(stage, &p, &stride), "map readback");
  NSMutableData *data = [NSMutableData dataWithLength:outW * outH * 4];
  for (uint32_t y = 0; y < outH; y++)
    memcpy((uint8_t *)data.mutableBytes + y * outW * 4, p + y * stride,
           outW * 4);
  gs_stagesurface_unmap(stage);
  gs_stagesurface_destroy(stage);
  gs_texrender_destroy(target);
  obs_leave_graphics();
  return data;
}
static const uint8_t *pixel(NSData *d, uint32_t width, int x, int y) {
  return (const uint8_t *)d.bytes + ((size_t)y * width + x) * 4;
}
static void color(NSData *d, uint32_t width, int x, int y, int r, int g, int b,
                  int a, const char *label) {
  const uint8_t *p = pixel(d, width, x, y);
  if (abs(p[0] - r) > 3 || abs(p[1] - g) > 3 || abs(p[2] - b) > 3 ||
      abs(p[3] - a) > 3) {
    fprintf(stderr, "FAIL %s (%d,%d): [%u %u %u %u] expected [%d %d %d %d]\n",
            label, x, y, p[0], p[1], p[2], p[3], r, g, b, a);
    exit(4);
  }
}
static void png(NSData *d, uint32_t w, uint32_t h, NSString *file) {
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
      initWithBitmapDataPlanes:NULL
                    pixelsWide:w
                    pixelsHigh:h
                 bitsPerSample:8
               samplesPerPixel:4
                      hasAlpha:YES
                      isPlanar:NO
                colorSpaceName:NSDeviceRGBColorSpace
                  bitmapFormat:NSBitmapFormatAlphaNonpremultiplied
                   bytesPerRow:w * 4
                  bitsPerPixel:32];
  memcpy(rep.bitmapData, d.bytes, w * h * 4);
  [[rep representationUsingType:NSBitmapImageFileTypePNG
                     properties:@{}] writeToFile:file atomically:YES];
}
/* Fixture bridge for actual v2 RenderPlan JSON. Resource handles are resolved
 * only against these trusted probe sources; this is not an app IPC endpoint. */
static struct producer_set_v2_node
node_descriptor(NSDictionary *node, NSDictionary *resources, unsigned depth) {
  require(depth <= 12, "fixture descriptor depth");
  NSDictionary *b = node[@"bounds"], *p = node[@"properties"];
  require(!p[@"rotation"] || [p[@"rotation"] floatValue] == 0,
          "fixture bridge rejects unsupported rotation");
  require(!p[@"scale"] || [p[@"scale"] floatValue] == 1,
          "fixture bridge rejects unsupported scale");
  struct producer_set_v2_node n = {0};
  n.id = [node[@"id"] UTF8String];
  n.x = [b[@"x"] floatValue];
  n.y = [b[@"y"] floatValue];
  n.width = [b[@"width"] floatValue];
  n.height = [b[@"height"] floatValue];
  n.radius = [node[@"mask"][@"radius"] floatValue];
  n.opacity = p[@"opacity"] ? [p[@"opacity"] floatValue] : 1;
  n.visible = !p[@"visible"] || [p[@"visible"] boolValue];
  n.fit = SET_V2_STRETCH;
  if ([node[@"kind"] isEqualToString:@"group"]) {
    n.kind = SET_V2_GROUP;
    NSArray *children = node[@"children"];
    n.child_count = children.count;
    require(n.child_count <= 128, "fixture child budget");
    struct producer_set_v2_node *out = calloc(n.child_count, sizeof(*out));
    require(!n.child_count || out, "descriptor allocation");
    for (size_t i = 0; i < n.child_count; i++)
      out[i] = node_descriptor(children[i], resources, depth + 1);
    n.children = out;
  } else {
    require([@[ @"source", @"graphic", @"asset" ] containsObject:node[@"kind"]],
            "fixture leaf resolver supports prepared source/graphic/asset");
    n.kind = SET_V2_SURFACE;
    n.surface = [resources[node[@"resource"]] pointerValue];
    if ([node[@"fit"] isEqualToString:@"contain"])
      n.fit = SET_V2_CONTAIN;
    if ([node[@"fit"] isEqualToString:@"cover"])
      n.fit = SET_V2_COVER;
  }
  return n;
}
static void free_descriptor(struct producer_set_v2_node *n) {
  for (size_t i = 0; i < n->child_count; i++)
    free_descriptor((struct producer_set_v2_node *)&n->children[i]);
  free((void *)n->children);
}
static void load_plugin(NSString *app, NSString *name) {
  NSString *base = [app
      stringByAppendingPathComponent:
          [NSString
              stringWithFormat:@"Contents/PlugIns/%@.plugin/Contents", name]];
  NSString *binary = [base
      stringByAppendingPathComponent:[@"MacOS/" stringByAppendingString:name]];
  NSString *data = [base stringByAppendingPathComponent:@"Resources"];
  void *module = NULL;
  require(obs_open_module(&module, binary.UTF8String, data.UTF8String) == 0 &&
              module && obs_init_module(module),
          "load media plugin");
}
static obs_source_t *file_source(NSString *kind, NSString *path) {
  NSDictionary *config =
      [kind isEqualToString:@"image_source"] ? @{@"file" : path} : @{
        @"is_local_file" : @YES,
        @"local_file" : path,
        @"looping" : @YES,
        @"restart_on_activate" : @YES,
        @"close_when_inactive" : @NO,
        @"hw_decode" : @NO
      };
  NSData *data = [NSJSONSerialization dataWithJSONObject:config
                                                 options:0
                                                   error:nil];
  NSString *json = [[NSString alloc] initWithData:data
                                         encoding:NSUTF8StringEncoding];
  obs_data_t *d = obs_data_create_from_json(json.UTF8String);
  obs_source_t *s =
      obs_source_create_private(kind.UTF8String, "Actual media proof", d);
  obs_data_release(d);
  require(s != NULL, "create actual media source");
  obs_source_set_audio_mixers(s, 0);
  return s;
}
static NSDictionary *media_proof(NSString *app, NSString *out) {
  load_plugin(app, @"image-source");
  load_plugin(app, @"obs-ffmpeg");
  obs_post_load_modules();
  obs_source_t *image = file_source(
                   @"image_source",
                   [out stringByAppendingPathComponent:@"media/topic.png"]),
               *video = file_source(
                   @"ffmpeg_source",
                   [out stringByAppendingPathComponent:@"media/clip.mp4"]);
  obs_source_t *root = producer_set_v2_group_create(640, 360, 0, 1),
               *panel = producer_set_v2_group_create(600, 300, 28, 1);
  obs_source_t *blue = solid(640, 360, 0, 0, 1, false),
               *red = solid(600, 300, 1, 0, 0, false),
               *yellow = solid(80, 50, 1, 1, 0, false);
  require(add(panel, red, 0, 0, 600, 300), "media group backdrop");
  require(add(panel, video, 10, 20, 280, 160), "decoded clip below graphics");
  require(producer_set_v2_group_add(panel, image, 310, 20, 280, 160, true),
          "linked image in mixed group");
  require(add(panel, yellow, 100, 80, 80, 50),
          "foreground graphic above decoded clip");
  producer_set_v2_group_seal(panel);
  add(root, blue, 0, 0, 640, 360);
  add(root, panel, 20, 30, 600, 300);
  producer_set_v2_group_seal(root);
  obs_source_inc_active(root);
  obs_source_inc_showing(root);
  obs_set_output_source(0, root);
  for (int i = 0; i < 200 && (!obs_source_get_width(video) ||
                              !obs_source_get_width(image));
       i++)
    usleep(10000);
  usleep(250000);
  require(obs_source_get_width(video) == 320 &&
              obs_source_get_width(image) == 320,
          "image and video dimensions ready");
  NSData *a = capture(root, 640, 360, 640, 360);
  usleep(180000);
  NSData *b = capture(root, 640, 360, 640, 360);
  require(![a isEqualToData:b], "decoded video advances inside mixed group");
  color(a, 640, 400, 130, 255, 0, 255, 255, "native image magenta half");
  color(a, 640, 550, 130, 0, 255, 255, 255, "native image cyan half");
  color(a, 640, 140, 130, 255, 255, 0, 255, "graphic overlays decoded video");
  color(a, 640, 21, 31, 0, 0, 255, 255, "media group mask");
  const uint8_t *one = pixel(a, 640, 60, 180), *two = pixel(a, 640, 260, 180);
  require((one[1] > 100 && one[1] > one[0] * 1.8 && one[1] > one[2] * 1.8) ||
              (two[1] > 100 && two[1] > two[0] * 1.8 && two[1] > two[2] * 1.8),
          "actual decoded clip pixels visible");
  png(a, 640, 360,
      [out stringByAppendingPathComponent:@"mixed-image-video.png"]);
  obs_set_output_source(0, NULL);
  obs_source_dec_showing(root);
  obs_source_dec_active(root);
  obs_source_release(root);
  obs_source_release(panel);
  obs_source_release(blue);
  obs_source_release(red);
  obs_source_release(yellow);
  obs_source_release(image);
  obs_source_release(video);
  for (int i = 0;
       i < 200 && (producer_set_v2_live_groups() || atomic_load(&source_live));
       i++)
    usleep(10000);
  require(producer_set_v2_live_groups() == 0 && atomic_load(&source_live) == 0,
          "media composition cleanup");
  return @{
    @"nativeImagePixels" : @YES,
    @"decodedVideoPixels" : @YES,
    @"videoAdvances" : @YES,
    @"foregroundOverVideo" : @YES,
    @"groupMask" : @YES,
    @"remainingGroups" : @(producer_set_v2_live_groups())
  };
}
static NSArray *transition_proof(NSString *out) {

  NSMutableArray *results = [NSMutableArray array];
  for (int mode = 0; mode < 3; mode++) {
    obs_source_t *from = solid(320, 180, 1, 0, 0, true),
                 *to = solid(320, 180, 0, 0, 1, true),
                 *transition = producer_set_v2_transition_create(from, to, 320,
                                                                 180, mode);
    require(transition != NULL, "create live-input transition");
    obs_source_inc_active(transition);
    obs_source_inc_showing(transition);
    obs_set_output_source(0, transition);
    usleep(50000);
    for (int step = 0; step < 3; step++) {
      float p = step * .5f;
      obs_enter_graphics();
      require(producer_set_v2_transition_frame(transition, p),
              "set transition progress");
      obs_leave_graphics();
      NSData *data = capture(transition, 320, 180, 320, 180);
      if (step == 0)
        color(data, 320, 160, 100, 255, 0, 0, 255, "transition start");
      else if (step == 2)
        color(data, 320, 160, 100, 0, 0, 255, 255, "transition end");
      else if (mode == 0)
        color(data, 320, 160, 100, 128, 0, 128, 255, "dissolve midpoint");
      else if (mode == 1) {
        color(data, 320, 80, 100, 0, 0, 255, 255, "wipe revealed half");
        color(data, 320, 240, 100, 255, 0, 0, 255, "wipe outgoing half");
      } else {
        color(data, 320, 80, 100, 255, 0, 0, 255, "slide outgoing half");
        color(data, 320, 240, 100, 0, 0, 255, 255, "slide incoming half");
      }
    }
    obs_enter_graphics();
    producer_set_v2_transition_frame(transition, .5);
    require(!producer_set_v2_transition_frame(transition, NAN),
            "reject NaN progress");
    obs_leave_graphics();
    NSData *a = capture(transition, 320, 180, 320, 180);
    usleep(180000);
    NSData *b = capture(transition, 320, 180, 320, 180);
    require(![a isEqualToData:b], "both transition inputs remain live");
    png(b, 320, 180,
        [out stringByAppendingPathComponent:
                 [NSString stringWithFormat:@"transition-%d.png", mode]]);
    obs_set_output_source(0, NULL);
    obs_source_dec_showing(transition);
    obs_source_dec_active(transition);
    obs_source_release(transition);
    obs_source_release(from);
    obs_source_release(to);
    for (int i = 0; i < 200 && (producer_set_v2_live_transitions() ||
                                atomic_load(&source_live));
         i++)
      usleep(10000);
    require(producer_set_v2_live_transitions() == 0 &&
                atomic_load(&source_live) == 0,
            "transition resources released");
    [results addObject:@{
      @"mode" : @[ @"dissolve", @"wipe", @"slide" ][mode],
      @"endpointsAndMidpoint" : @YES,
      @"inputsStayLive" : @YES,
      @"cleanup" : @YES
    }];
  }
  return results;
}
static NSDictionary *rust_call(void *owner, NSDictionary *action,
                               obs_source_t *camera, bool expectOK) {
  NSData *json = [NSJSONSerialization dataWithJSONObject:action
                                                 options:0
                                                   error:nil];
  char reply[2000] = {0};
  bool ok =
      sets_v2_rust_dispatch(owner,
                            [[NSString alloc] initWithData:json
                                                  encoding:NSUTF8StringEncoding]
                                .UTF8String,
                            camera, reply, sizeof(reply));
  if (ok != expectOK)
    fprintf(stderr, "rust dispatch response: %s\n", reply);
  require(ok == expectOK,
          "actual app adapter request accepted/rejected as expected");
  NSDictionary *result = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithBytes:reply length:strlen(reply)]
                 options:0
                   error:nil];
  require(result != nil, "actual app adapter status decoded");
  return result;
}
static NSArray *rust_adapter_proof(NSString *out) {
  NSMutableArray *checks = [NSMutableArray array];
  for (NSString *orientation in @[ @"landscape", @"portrait" ]) {
    NSString *file =
        [out stringByAppendingPathComponent:
                 [orientation stringByAppendingString:@"-plan.json"]];
    NSMutableDictionary *plan = [[NSJSONSerialization
        JSONObjectWithData:[NSData dataWithContentsOfFile:file]
                   options:NSJSONReadingMutableContainers
                     error:nil] mutableCopy];
    uint32_t w = [plan[@"target"][@"width"] unsignedIntValue],
             h = [plan[@"target"][@"height"] unsignedIntValue];
    obs_scene_t *room = obs_scene_create_private("Actual Rust v2 adapter room");
    obs_source_t *roomSource = obs_scene_get_source(room),
                 *camera = solid(400, 300, 0, 1, 0, true);
    obs_set_output_source(0, roomSource);
    void *owner = sets_v2_rust_attach(room, w, h);
    require(owner != NULL, "exact app RoomProgram attaches to native room");
    rust_call(
        owner, @{
          @"op" : @"prepare",
          @"generation" : @6,
          @"revision" : @1,
          @"plan" : plan
        },
        camera, false);
    // Malformed transform cannot change native composition or start a resource.
    plan[@"viewport"][@"scaleX"] = @999;
    rust_call(
        owner, @{
          @"op" : @"prepare",
          @"generation" : @7,
          @"revision" : @1,
          @"plan" : plan
        },
        camera, false);
    plan = [NSJSONSerialization
        JSONObjectWithData:[NSData dataWithContentsOfFile:file]
                   options:NSJSONReadingMutableContainers
                     error:nil];
    // A valid-looking compiled binding still cannot resolve an unauthorized
    // room source. Native resolution, not package data, owns source pointers.
    NSMutableDictionary *binding =
        plan[@"root"][@"children"][1][@"children"][1];
    binding[@"resource"] = @"unowned-camera";
    NSMutableArray *manifest = plan[@"resources"];
    NSUInteger resourceIndex = [manifest indexOfObject:@"synthetic-camera"];
    require(resourceIndex != NSNotFound, "compiled fixture source manifest");
    manifest[resourceIndex] = @"unowned-camera";
    rust_call(
        owner, @{
          @"op" : @"prepare",
          @"generation" : @7,
          @"revision" : @1,
          @"plan" : plan
        },
        camera, false);
    binding[@"resource"] = @"synthetic-camera";
    manifest[resourceIndex] = @"synthetic-camera";
    rust_call(
        owner, @{
          @"op" : @"prepare",
          @"generation" : @7,
          @"revision" : @1,
          @"plan" : plan
        },
        camera, true);
    NSDictionary *status = nil;
    for (int i = 0; i < 300; i++) {
      status = rust_call(
          owner,
          @{@"op" : @"status",
            @"generation" : @7},
          camera, true);
      if ([status[@"ready"] boolValue] && [status[@"warmed"] boolValue])
        break;
      usleep(20000);
    }
    require([status[@"ready"] boolValue] && [status[@"warmed"] boolValue],
            "actual graphics marker confirms first CEF paint");
    require([status[@"renderedRevision"] unsignedLongLongValue] == 0,
            "first paint preparation stays off air");
    rust_call(
        owner, @{
          @"op" : @"take",
          @"generation" : @7,
          @"revision" : @1,
          @"durationMs" : @300,
          @"mode" : @"dissolve"
        },
        camera, true);
    for (int i = 0; i < 200; i++) {
      status = rust_call(
          owner,
          @{@"op" : @"status",
            @"generation" : @7},
          camera, true);
      if ([status[@"renderedRevision"] unsignedLongLongValue] == 1)
        break;
      usleep(20000);
    }
    require([status[@"renderedRevision"] unsignedLongLongValue] == 1,
            "exact app adapter returns native rendered receipt");
    NSData *frame = capture(roomSource, w, h, w, h);
    color(frame, w, w * .05, h * .05, 0, 0, 255, 255, "Rust graph background");
    color(frame, w, 0, h - 1, 0, 0, 255, 255,
          "graphics readiness marker excluded from outgoing output");
    color(frame, w, w * .15, h * .30, 255, 0, 0, 255,
          "Rust graphics below native capture");
    color(frame, w, w * .40, h * .50, 0, 255, 0, 255,
          "Rust native capture above browser graphics");
    color(frame, w, w * .50, h * .50, 255, 255, 0, 255,
          "Rust browser graphics above native capture");
    color(frame, w, w * .10 + 1, h * .20 + 1, 0, 0, 255, 255,
          "Rust nested whole-group mask");
    png(frame, w, h,
        [out stringByAppendingPathComponent:
                 [orientation stringByAppendingString:@"-rust-room.png"]]);
    rust_call(
        owner, @{
          @"op" : @"prepare",
          @"generation" : @7,
          @"revision" : @1,
          @"plan" : plan
        },
        camera, false);
    [checks addObject:@{
      @"orientation" : orientation,
      @"exactAppAdapter" : @YES,
      @"strictNativePlanValidation" : @YES,
      @"sourceAuthorization" : @YES,
      @"actualBrowserPaintMarker" : @YES,
      @"markerCroppedFromOutput" : @YES,
      @"orderedRoomPixels" : @YES,
      @"nativeRenderedReceipt" : @YES
    }];
    sets_v2_rust_release(owner);
    obs_set_output_source(0, NULL);
    obs_scene_release(room);
    obs_source_release(camera);
    for (int i = 0; i < 300 && (producer_set_v2_live_programs() ||
                                producer_set_v2_live_groups() ||
                                atomic_load(&source_live));
         i++)
      usleep(10000);
    require(!producer_set_v2_live_programs() &&
                !producer_set_v2_live_groups() && !atomic_load(&source_live),
            "Rust app adapter room/resources cleanup");
  }
  return checks;
}


static NSArray *real_room_proof(NSString *out) {
  NSString *folder = @(getenv("PRODUCER_ROOM_FIXTURES") ?: "/private/tmp/producer-sets-v2-room-fixtures");
  NSArray *files = [[[NSFileManager defaultManager] contentsOfDirectoryAtPath:folder error:nil] sortedArrayUsingSelector:@selector(compare:)];
  require(files.count >= 10, "real authored room fixtures available");
  NSMutableArray *checks = [NSMutableArray array];
  for (NSString *file in files) {
    if (![file hasSuffix:@".json"]) continue;
    NSDictionary *plan = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:file]] options:0 error:nil];
    uint32_t w = [plan[@"target"][@"width"] unsignedIntValue], h = [plan[@"target"][@"height"] unsignedIntValue];
    obs_scene_t *room = obs_scene_create_private("Authored room integration");
    obs_source_t *source = obs_scene_get_source(room), *camera = solid(640,480,0,1,0,true);
    obs_set_output_source(0, source);
    void *owner = sets_v2_rust_attach(room,w,h);
    require(owner != NULL,"authored room attaches");
    rust_call(owner,@{@"op":@"prepare",@"generation":@7,@"revision":@1,@"plan":plan},camera,true);
    NSDictionary *status = nil;
    for (int i=0;i<700;i++) {
      status=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);
      if ([status[@"ready"] boolValue] && [status[@"warmed"] boolValue]) break;
      usleep(20000);
    }
    require([status[@"ready"] boolValue] && [status[@"warmed"] boolValue],"authored set first paint and resource readiness");
    rust_call(owner,@{@"op":@"take",@"generation":@7,@"revision":@1,@"durationMs":@0,@"mode":@"dissolve"},camera,true);
    for(int i=0;i<250;i++) {
      status=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);
      if ([status[@"renderedRevision"] intValue]==1) break;
      usleep(20000);
    }
    require([status[@"renderedRevision"] intValue]==1,"authored set rendered receipt");
    // Prepare two off-air records, then revisit the first without another build.
    for(int index=0;index<2;index++){
      NSString *key=index?@"prepared-b":@"prepared-a";
      rust_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@(index+2),@"key":key,@"plan":plan},camera,true);
      for(int i=0;i<700;i++){
        status=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);
        if([status[@"cachedKeys"] containsObject:key])break;usleep(20000);
      }
      require([status[@"cachedKeys"] containsObject:key],"prepared layout has native first paint receipt");
    }
    require([status[@"cachedKeys"] count]==2,"multiple prepared layouts remain resident");
    rust_call(owner,@{@"op":@"retain",@"generation":@7,@"keys":@[@"prepared-a",@"prepared-b"]},camera,true);
    for(int index=0;index<2;index++){
      uint64_t revision=4+index;double start=CFAbsoluteTimeGetCurrent()*1000.;
      NSMutableDictionary *entry=[plan mutableCopy];entry[@"assets"]=@{};
      rust_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":@(revision),@"key":@"prepared-a",@"plan":entry},camera,true);
      rust_call(owner,@{@"op":@"take",@"generation":@7,@"revision":@(revision),@"durationMs":@0,@"mode":@"dissolve"},camera,true);
      for(int i=0;i<200;i++){status=rust_call(owner,@{@"op":@"status",@"generation":@7},camera,true);if([status[@"renderedRevision"] unsignedLongLongValue]==revision)break;usleep(10000);}
      require([status[@"renderedRevision"] unsignedLongLongValue]==revision,"retained scene repeat take renders");
      require([status[@"cachedKeys"] count]==2,"taking does not consume ready scene bank");
      fprintf(stderr,"Cached scene take %s: %.2f ms\n",file.UTF8String,CFAbsoluteTimeGetCurrent()*1000.-start);
    }
    NSMutableDictionary *stale=[plan mutableCopy];stale[@"assets"]=@{};
    NSMutableDictionary *changedRoot=[plan[@"root"] mutableCopy];
    NSMutableDictionary *properties=[changedRoot[@"properties"] mutableCopy]?:[NSMutableDictionary dictionary];properties[@"opacity"]=@0.25;changedRoot[@"properties"]=properties;stale[@"root"]=changedRoot;
    rust_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":@6,@"key":@"prepared-a",@"plan":stale},camera,false);
    NSData *frame=capture(source,w,h,w,h);
    png(frame,w,h,[out stringByAppendingPathComponent:[[file stringByDeletingPathExtension] stringByAppendingString:@"-room.png"]]);
    [checks addObject:@{@"file":file,@"rendered":@YES,@"resources":plan[@"resources"]}];
    fprintf(stderr,"Authored room rendered: %s\n",file.UTF8String);
    sets_v2_rust_release(owner);obs_set_output_source(0,NULL);obs_scene_release(room);obs_source_release(camera);
    for(int i=0;i<300 && producer_set_v2_live_groups();i++) usleep(10000);
    require(!producer_set_v2_live_groups(),"authored room groups released");
  }
  return checks;
}

static NSDictionary *sharpness_proof(NSString *out) {
  NSMutableArray *checks=[NSMutableArray array];
  for (NSNumber *factor in @[@1.5,@2]) for (NSString *orientation in @[@"landscape",@"portrait"]) for (NSString *mode in @[@"nested",@"masked"]) {
    NSMutableArray<NSData *> *frames=[NSMutableArray array];
    double density=factor.doubleValue;
    uint32_t w=([orientation isEqualToString:@"portrait"]?180:320)*density,h=([orientation isEqualToString:@"portrait"]?320:180)*density;
    for (NSString *variant in @[@"design",@"reference"]) {
      NSString *stem=[NSString stringWithFormat:@"sharpness-%@-%@-%@-%@",factor,orientation,mode,variant];
      NSDictionary *plan=[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[out stringByAppendingPathComponent:[stem stringByAppendingString:@".json"]]] options:0 error:nil];
      obs_scene_t *room=obs_scene_create_private("Sharpness proof");obs_source_t *source=obs_scene_get_source(room);
      obs_set_output_source(0,source);void *owner=sets_v2_rust_attach(room,w,h);
      require(owner!=NULL,"sharpness room attaches");
      rust_call(owner,@{@"op":@"preload",@"generation":@7,@"revision":@1,@"key":@"sharpness",@"plan":plan},NULL,true);
      NSDictionary *status=nil;
      for(int i=0;i<700;i++){status=rust_call(owner,@{@"op":@"status",@"generation":@7},NULL,true);if([status[@"cachedKeys"] containsObject:@"sharpness"])break;usleep(20000);}
      require([status[@"cachedKeys"] containsObject:@"sharpness"],"density-aware graphics first paint");
      rust_call(owner,@{@"op":@"activate",@"generation":@7,@"revision":@2,@"key":@"sharpness",@"plan":plan},NULL,true);
      rust_call(owner,@{@"op":@"take",@"generation":@7,@"revision":@2,@"durationMs":@0,@"mode":@"dissolve"},NULL,true);
      for(int i=0;i<250;i++){status=rust_call(owner,@{@"op":@"status",@"generation":@7},NULL,true);if([status[@"renderedRevision"] intValue]==2)break;usleep(20000);}
      require([status[@"renderedRevision"] intValue]==2,"sharpness cached take renders");
      NSData *frame=capture(source,w,h,w,h);[frames addObject:frame];png(frame,w,h,[out stringByAppendingPathComponent:[stem stringByAppendingString:@".png"]]);
      sets_v2_rust_release(owner);obs_set_output_source(0,NULL);obs_scene_release(room);
      for(int i=0;i<300&&producer_set_v2_live_groups();i++)usleep(10000);
      require(!producer_set_v2_live_groups(),"sharpness groups released");
    }
    double error=0;unsigned gray=0,samples=0;
    // Compare text and one-output-pixel lines, excluding rounded outer edges.
    for(int y=ceil(20*density);y<110*density;y++)for(int x=ceil(20*density);x<135*density;x++){
      const uint8_t *a=pixel(frames[0],w,x,y),*b=pixel(frames[1],w,x,y);
      for(int c=0;c<4;c++)error+=abs(a[c]-b[c]);
      if(y>=ceil(21*density)&&y<36*density&&x>=ceil(21*density)&&x<20*density+62){samples++;if(a[0]>8&&a[0]<247)gray++;}
    }
    error/=(110*density-ceil(20*density))*(135*density-ceil(20*density))*4.;double softened=(double)gray/samples;
    fprintf(stderr,"Sharpness %s/%s MAE %.3f; softened stripe pixels %.3f\n",orientation.UTF8String,mode.UTF8String,error,softened);
    require(error<3,"upscaled design matches output-resolution text reference");
    require(softened<0.02,"one-output-pixel stripe contrast preserved through nested groups");
    [checks addObject:@{@"density":factor,@"orientation":orientation,@"mode":mode,@"meanAbsolutePixelError":@(error),@"softenedStripeFraction":@(softened)}];
  }
  return @{@"outputResolutionReference":checks};
}

static struct producer_set_v2_program_status program_status(obs_source_t *p) {
  struct producer_set_v2_program_status status = {0};
  require(producer_set_v2_program_status(p, &status), "native program status");
  return status;
}
static void wait_program(obs_source_t *p, uint64_t revision) {
  for (int i = 0; i < 300 && program_status(p).rendered_revision != revision;
       i++)
    usleep(10000);
  require(program_status(p).rendered_revision == revision,
          "candidate endpoint rendered receipt");
}
static NSArray *program_proof(NSString *out) {

  NSMutableArray *checks = [NSMutableArray array];
  for (int orientation = 0; orientation < 2; orientation++) {
    uint32_t w = orientation ? 360 : 640, h = orientation ? 640 : 360;
    obs_scene_t *room = obs_scene_create_private("Isolated v2 room");
    require(room != NULL, "actual OBS room scene");
    obs_source_t *source = obs_scene_get_source(room),
                 *back = solid(w, h, 0, 0, 1, false),
                 *red = solid(w, h, 1, 0, 0, true),
                 *green = solid(w, h, 0, 1, 0, true),
                 *program = producer_set_v2_program_create(w, h);
    require(program != NULL, "create native frame-driven program source");
    require(obs_scene_add(room, back) && obs_scene_add(room, program),
            "native program attached above room sources");
    obs_source_set_audio_mixers(program, 0);
    obs_set_output_source(0, source);
    require(producer_set_v2_program_prepare(program, red, 1),
            "prepare first segment off air");
    require(
        !producer_set_v2_program_take(program, 1, 0, PRODUCER_SET_V2_DISSOLVE),
        "unready segment cannot take");
    NSData *frame = capture(source, w, h, w, h);
    color(frame, w, w / 2, h * 3 / 4, 0, 0, 255, 255,
          "preparing does not replace room output");
    require(program_status(program).warmed,
            "native program warms detached candidate");
    require(producer_set_v2_program_ready(program, 1),
            "resource owner confirms first segment readiness");
    require(!producer_set_v2_program_ready(program, 99),
            "stale readiness rejected");
    require(
        producer_set_v2_program_take(program, 1, 0, PRODUCER_SET_V2_DISSOLVE),
        "queue initial cut");
    wait_program(program, 1);
    color(capture(source, w, h, w, h), w, w / 2, h * 3 / 4, 255, 0, 0, 255,
          "first segment actually on room output");
    uint64_t revision = 1;
    unsigned midframes = 0;
    for (int mode = 0; mode < 3; mode++) {
      obs_source_t *next = (mode % 2 == 0) ? green : red;
      require(producer_set_v2_program_prepare(program, next, ++revision),
              "preload next segment");
      frame = capture(source, w, h, w, h);
      require(program_status(program).rendered_revision == revision - 1,
              "preparing cannot advance rendered revision");
      color(frame, w, w / 2, h * 3 / 4, mode % 2 == 0 ? 255 : 0,
            mode % 2 == 0 ? 0 : 255, 0, 255,
            "outgoing segment stays visible during prepare");
      require(producer_set_v2_program_ready(program, revision),
              "next resources ready");
      require(producer_set_v2_program_take(program, revision, 600, mode),
              "queue native-clock transition");
      require(!producer_set_v2_program_take(program, revision, 600, mode),
              "duplicate take rejected");
      for (int i = 0; i < 100; i++) {
        struct producer_set_v2_program_status st = program_status(program);
        if (st.transitioning && st.transition_progress > .2 &&
            st.transition_progress < .8) {
          require(producer_set_v2_program_pause(program, true),
                  "pause native clock");
          st = program_status(program);
          double paused = st.clock_ms;
          frame = capture(source, w, h, w, h);
          const uint8_t *center = pixel(frame, w, w / 2, h * 3 / 4);
          require(center[3] == 255 && center[0] + center[1] > 245 &&
                      center[2] < 5,
                  "transition output stays opaque without black gap");
          usleep(100000);
          require(fabs(program_status(program).clock_ms - paused) < .001,
                  "native pause holds presentation time");
          NSData *held = capture(source, w, h, w, h);
          const uint8_t *heldCenter = pixel(held, w, w / 2, h * 3 / 4);
          require(abs(center[0] - heldCenter[0]) < 3 &&
                      abs(center[1] - heldCenter[1]) < 3,
                  "pause holds transition position");
          require(!producer_set_v2_program_collect(program),
                  "cannot release outgoing segment during transition");
          require(!producer_set_v2_program_prepare(program, next, revision + 1),
                  "bounded transition cannot be overwritten mid-render");
          png(frame, w, h,
              [out stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"program-%d-%d.png",
                                                  orientation, mode]]);
          require(producer_set_v2_program_pause(program, false),
                  "resume native clock");
          midframes++;
          break;
        }
        usleep(10000);
      }
      require(midframes == (unsigned)mode + 1,
              "native transition midpoint observed");
      wait_program(program, revision);
      frame = capture(source, w, h, w, h);
      color(frame, w, w / 2, h * 3 / 4, mode % 2 == 0 ? 0 : 255,
            mode % 2 == 0 ? 255 : 0, 0, 255,
            "new segment endpoint on room output");
      require(producer_set_v2_program_collect(program),
              "retired source collection after rendered endpoint");
    }
    uint64_t lastConfirmed = revision;
    unsigned continuitySamples = 0;
    for (int cycle = 0; cycle < 12; cycle++) {
      obs_source_t *next = (cycle % 2 == 0) ? red : green;
      require(producer_set_v2_program_prepare(program, next, ++revision),
              "repeated Next/Back preload");
      capture(source, w, h, w, h);
      require(producer_set_v2_program_ready(program, revision),
              "repeated segment resources ready");
      require(producer_set_v2_program_take(program, revision, 120, cycle % 3),
              "repeated Next/Back native take");
      for (int sample = 0; sample < 100; sample++) {
        NSData *continuous = capture(source, w, h, w, h);
        for (int edge = 1; edge <= 3; edge++) {
          const uint8_t *p = pixel(continuous, w, w * edge / 4, h * 3 / 4);
          require(p[3] == 255 && p[0] + p[1] > 245 && p[2] < 5,
                  "repeated segment switch keeps opaque live output at sample");
        }
        continuitySamples++;
        if (program_status(program).rendered_revision == revision)
          break;
        usleep(10000);
      }
      wait_program(program, revision);
      lastConfirmed = revision;
      require(producer_set_v2_program_collect(program),
              "repeated Next/Back retire collection");
    }
    // Superseded preparation cannot take; cancellation keeps current output.
    require(producer_set_v2_program_prepare(program, red, ++revision),
            "prepare cancellable segment");
    require(producer_set_v2_program_prepare(program, green, ++revision),
            "latest preparation replaces older candidate");
    require(!producer_set_v2_program_ready(program, revision - 1),
            "superseded readiness rejected");
    require(!producer_set_v2_program_take(program, revision - 1, 0, 0),
            "superseded take rejected");
    require(producer_set_v2_program_cancel(program, revision),
            "cancel current preparation");
    require(!producer_set_v2_program_prepare(program, red, revision - 1),
            "old revision cannot revive cancelled intent");
    color(capture(source, w, h, w, h), w, w / 2, h * 3 / 4, 0, 255, 0, 255,
          "cancel preserves confirmed program");
    struct producer_set_v2_program_status st = program_status(program);
    require(st.rendered_revision == lastConfirmed && st.render_serial > 0,
            "rendered receipt only advances after completed take");
    [checks addObject:@{
      @"orientation" : orientation ? @"portrait" : @"landscape",
      @"actualRoomScene" : @YES,
      @"offAirPreparation" : @YES,
      @"nativeClockTransitions" : @3,
      @"midpointFrames" : @(midframes),
      @"nextBackSwitches" : @12,
      @"continuitySamples" : @(continuitySamples),
      @"pauseResume" : @YES,
      @"noBlackGapAtSamples" : @YES,
      @"latestPreparationWins" : @YES,
      @"staleAndCancelledTakeRejected" : @YES,
      @"endpointRenderedRevision" : @(st.rendered_revision),
      @"renderSerial" : @(st.render_serial)
    }];
    obs_set_output_source(0, NULL);
    obs_scene_release(room);
    obs_source_release(back);
    obs_source_release(red);
    obs_source_release(green);
    obs_source_release(program);
    for (int i = 0; i < 300 && (producer_set_v2_live_programs() ||
                                producer_set_v2_live_transitions() ||
                                atomic_load(&source_live));
         i++)
      usleep(10000);
    require(!producer_set_v2_live_programs() &&
                !producer_set_v2_live_transitions() &&
                !atomic_load(&source_live),
            "room/program/transition/source teardown");
  }
  return checks;
}

static NSDictionary *owner_proof(NSString *out) {
  obs_source_t *blue = solid(320, 240, 0, 0, 1, false),
               *green = solid(160, 120, 0, 1, 0, false);
  struct producer_set_v2_node children[2] = {{.id = "backdrop",
                                              .kind = SET_V2_SURFACE,
                                              .width = 320,
                                              .height = 240,
                                              .opacity = 1,
                                              .visible = true,
                                              .fit = SET_V2_STRETCH,
                                              .surface = blue},
                                             {.id = "capture",
                                              .kind = SET_V2_SURFACE,
                                              .x = 80,
                                              .y = 60,
                                              .width = 160,
                                              .height = 120,
                                              .opacity = 1,
                                              .visible = true,
                                              .fit = SET_V2_STRETCH,
                                              .surface = green}};
  struct producer_set_v2_node root = {.id = "root",
                                      .kind = SET_V2_GROUP,
                                      .width = 320,
                                      .height = 240,
                                      .opacity = 1,
                                      .visible = true,
                                      .fit = SET_V2_STRETCH,
                                      .children = children,
                                      .child_count = 2};
  char error[200];
  const size_t budget = 16 * 1024 * 1024;
  children[1].id = "backdrop";
  require(!producer_set_v2_scene_prepare(&root, 640, 360, SET_V2_CONTAIN,
                                         budget, error, sizeof(error)),
          "owner rejects duplicate node identities");
  children[1].id = "capture";
  children[1].surface = NULL;
  require(!producer_set_v2_scene_prepare(&root, 640, 360, SET_V2_CONTAIN,
                                         budget, error, sizeof(error)),
          "owner rejects unresolved surfaces");
  children[1].surface = green;
  children[1].opacity = NAN;
  require(!producer_set_v2_scene_prepare(&root, 640, 360, SET_V2_CONTAIN,
                                         budget, error, sizeof(error)),
          "owner rejects invalid style");
  children[1].opacity = 1;
  require(!producer_set_v2_live_groups(),
          "invalid native preparations allocate no groups");
  for (int mode = SET_V2_STRETCH; mode <= SET_V2_COVER; mode++) {
    struct producer_set_v2_scene *scene = producer_set_v2_scene_prepare(
        &root, 640, 360, mode, budget, error, sizeof(error));
    require(scene != NULL, "prepare custom aspect viewport");
    require(producer_set_v2_scene_group_count(scene) == 4,
            "actual native color target count");
    size_t rasterScale=mode==SET_V2_CONTAIN?3:4; // twice the density: 1.5x or 2x
    require(producer_set_v2_scene_texture_bytes(scene) ==
                (640 * 360 + (320 * 240 * 2 + 160 * 120)*rasterScale*rasterScale/4) * 4,
            "actual native color target byte budget");
    obs_source_t *output = producer_set_v2_scene_source(scene);
    NSData *frame = capture(output, 640, 360, 640, 360);
    color(frame, 640, 320, 180, 0, 255, 0, 255,
          "viewport center retains source");
    if (mode == SET_V2_CONTAIN) {
      color(frame, 640, 10, 180, 0, 0, 0, 0, "contain transparent letterbox");
      color(frame, 640, 180, 180, 0, 0, 255, 255,
            "contain preserves canvas aspect");
    } else {
      color(frame, 640, 10, 180, 0, 0, 255, 255, "viewport fills output");
      color(frame, 640, 180, 180, 0, 255, 0, 255,
            "cover/stretch source scaling");
      if (mode == SET_V2_COVER)
        color(frame, 640, 200, 80, 0, 255, 0, 255,
              "cover crops authored canvas vertically");
      else
        color(frame, 640, 200, 80, 0, 0, 255, 255,
              "stretch preserves complete authored canvas");
    }
    size_t held = producer_set_v2_live_groups();
    require(!producer_set_v2_scene_prepare(&root, 640, 360, mode, 1, error,
                                           sizeof(error)),
            "failed new preparation keeps existing scene");
    require(producer_set_v2_live_groups() == held,
            "failed preparation adds no native groups");
    color(capture(output, 640, 360, 640, 360), 640, 320, 180, 0, 255, 0, 255,
          "existing graph remains renderable after failed preparation");
    png(frame, 640, 360,
        [out stringByAppendingPathComponent:
                 [NSString stringWithFormat:@"viewport-%d.png", mode]]);
    producer_set_v2_scene_release(scene);
    for (int i = 0; i < 200 && producer_set_v2_live_groups(); i++)
      usleep(10000);
    require(!producer_set_v2_live_groups(),
            "native owner releases complete graph");
  }
  obs_source_release(blue);
  obs_source_release(green);
  for (int i = 0; i < 200 && atomic_load(&source_live); i++)
    usleep(10000);
  require(!atomic_load(&source_live),
          "native owner retains/releases prepared surfaces correctly");
  return @{
    @"contain" : @YES,
    @"cover" : @YES,
    @"stretch" : @YES,
    @"actualColorTargetBudget" : @YES,
    @"preflightRejectsInvalidGraph" : @YES,
    @"failedPreparePreservesExistingGraph" : @YES,
    @"cleanup" : @YES
  };
}

static NSDictionary *placement_proof(NSString *out) {
  obs_source_t *root = producer_set_v2_group_create(640, 360, 0, 1);
  obs_source_t *blue = solid(640, 360, 0, 0, 1, false);
  obs_source_t *captureSource = solid(160, 120, 1, 0, 0, true);
  require(add(root, blue, 0, 0, 640, 360), "placement backdrop");
  require(add(root, captureSource, 40, 60, 160, 120),
          "first capture placement");
  require(add(root, captureSource, 400, 60, 160, 120),
          "shared capture placement");
  require(!producer_set_v2_group_layer_frame(root, 1, 0, 0, 160, 120, true),
          "unsealed placements cannot animate");
  producer_set_v2_group_seal(root);
  obs_source_inc_active(root);
  obs_source_inc_showing(root);
  obs_set_output_source(0, root);
  NSData *frame = capture(root, 640, 360, 640, 360);
  color(frame, 640, 80, 120, 255, 0, 0, 255, "capture first position");
  color(frame, 640, 480, 120, 255, 0, 0, 255, "shared source second position");
  obs_enter_graphics();
  require(producer_set_v2_group_layer_frame(root, 1, 200, 200, 240, 120, true),
          "native placement geometry frame");
  require(!producer_set_v2_group_layer_frame(root, 1, NAN, 0, 10, 10, true),
          "reject invalid geometry without changing placement");
  require(!producer_set_v2_group_layer_frame(root, 99, 0, 0, 10, 10, true),
          "reject unknown placement");
  obs_leave_graphics();
  frame = capture(root, 640, 360, 640, 360);
  color(frame, 640, 80, 120, 0, 0, 255, 255, "old placement clears");
  color(frame, 640, 300, 260, 255, 0, 0, 255,
        "native geometry moves and resizes capture");
  color(frame, 640, 480, 120, 255, 0, 0, 255,
        "shared capture position unchanged");
  png(frame, 640, 360,
      [out stringByAppendingPathComponent:@"placement-motion.png"]);
  obs_enter_graphics();
  require(producer_set_v2_group_layer_frame(root, 1, 200, 200, 240, 120, false),
          "native visibility frame");
  obs_leave_graphics();
  frame = capture(root, 640, 360, 640, 360);
  color(frame, 640, 300, 260, 0, 0, 255, 255, "hidden placement clears");
  color(frame, 640, 480, 120, 255, 0, 0, 255,
        "other capture placement remains visible");
  obs_set_output_source(0, NULL);
  obs_source_dec_showing(root);
  obs_source_dec_active(root);
  obs_source_release(root);
  obs_source_release(blue);
  obs_source_release(captureSource);
  for (int i = 0;
       i < 200 && (producer_set_v2_live_groups() || atomic_load(&source_live));
       i++)
    usleep(10000);
  require(!producer_set_v2_live_groups() && !atomic_load(&source_live),
          "placement graph and shared source cleanup");
  return @{
    @"nativeGeometryUpdates" : @YES,
    @"sharedCaptureIsolation" : @YES,
    @"visibility" : @YES,
    @"invalidFrameRejected" : @YES,
    @"cleanup" : @YES
  };
}

static NSDictionary *browser_proof(NSString *app, NSString *out) {
  load_plugin(app, @"obs-browser");
  obs_post_load_modules();
  NSString *backHTML =
      [NSString stringWithContentsOfFile:
                    [out stringByAppendingPathComponent:@"background.html"]
                                encoding:NSUTF8StringEncoding
                                   error:nil];
  NSString *frontHTML =
      [NSString stringWithContentsOfFile:
                    [out stringByAppendingPathComponent:@"foreground.html"]
                                encoding:NSUTF8StringEncoding
                                   error:nil];
  require(backHTML && frontHTML,
          "graphics batch documents generated by v2 serializer");
  NSMutableArray *browserSources = [NSMutableArray array];
  for (NSArray *entry in
       @[ @[ @"background", backHTML ], @[ @"foreground", frontHTML ] ]) {
    NSString *file = [out
        stringByAppendingPathComponent:[entry[0]
                                           stringByAppendingString:@".html"]];
    [entry[1] writeToFile:file
               atomically:YES
                 encoding:NSUTF8StringEncoding
                    error:nil];
    NSDictionary *config = @{
      @"url" : [@"data:text/html;base64,"
          stringByAppendingString:[[entry[1]
                                      dataUsingEncoding:NSUTF8StringEncoding]
                                      base64EncodedStringWithOptions:0]],
      @"is_local_file" : @NO,
      @"css" : @"",
      @"width" : @320,
      @"height" : @240,
      @"fps" : @30,
      @"fps_custom" : @YES,
      @"shutdown" : @NO,
      @"restart_when_active" : @NO,
      @"reroute_audio" : @YES,
      @"webpage_control_level" : @0
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:config
                                                   options:0
                                                     error:nil];
    obs_data_t *d = obs_data_create_from_json(
        [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]
            .UTF8String);
    obs_source_t *s = obs_source_create_private(
        "browser_source", [(NSString *)entry[0] UTF8String], d);
    obs_data_release(d);
    require(s != NULL, "create actual HTML graphics source");
    obs_source_set_audio_mixers(s, 0);
    [browserSources addObject:[NSValue valueWithPointer:s]];
  }
  obs_source_t *root = producer_set_v2_group_create(640, 360, 0, 1),
               *panel = producer_set_v2_group_create(320, 240, 28, 1),
               *live = solid(160, 120, 0, 1, 0, true),
               *blue = solid(640, 360, 0, 0, 1, false);
  obs_source_t *back = [browserSources[0] pointerValue],
               *front = [browserSources[1] pointerValue];
  require(add(panel, back, 0, 0, 320, 240), "HTML below native source");
  require(add(panel, live, 80, 60, 160, 120),
          "native source between HTML layers");
  require(add(panel, front, 0, 0, 320, 240), "HTML above native source");
  producer_set_v2_group_seal(panel);
  add(root, blue, 0, 0, 640, 360);
  add(root, panel, 160, 60, 320, 240);
  producer_set_v2_group_seal(root);
  obs_source_inc_active(root);
  obs_source_inc_showing(root);
  obs_set_output_source(0, root);
  require(obs_source_active(back) && obs_source_showing(back) &&
              obs_source_active(front) && obs_source_showing(front),
          "nested source activation propagates to browser layers");
  NSData *frame = nil;
  bool ready = false;
  for (int i = 0; i < (getenv("SETS_V2_CEF_DEBUG") ? 1200 : 200); i++) {
    frame = capture(root, 640, 360, 640, 360);
    const uint8_t *p = pixel(frame, 640, 270, 145);
    const uint8_t *q = pixel(frame, 640, 200, 260);
    if (p[0] > 250 && p[1] > 250 && p[2] < 5 && q[0] < 5 && q[1] > 250 &&
        q[2] > 250) {
      ready = true;
      break;
    }
    usleep(50000);
  }
  if (!ready) {
    png(frame, 640, 360,
        [out stringByAppendingPathComponent:@"browser-failed.png"]);
    png(capture(back, 320, 240, 320, 240), 320, 240,
        [out stringByAppendingPathComponent:@"browser-back-failed.png"]);
  }
  require(ready, "actual browser surfaces painted expected pixels");
  color(frame, 640, 200, 260, 0, 255, 255, 255,
        "HTML background below native source");
  color(frame, 640, 250, 210, 0, 255, 0, 255,
        "native source above HTML background");
  color(frame, 640, 270, 145, 255, 255, 0, 255,
        "HTML card above native source");
  color(frame, 640, 161, 61, 0, 0, 255, 255,
        "mixed HTML/native group clipped at corner");
  unsigned textPixels = 0;
  for (int y = 145; y < 205; y++)
    for (int x = 270; x < 370; x++) {
      const uint8_t *p = pixel(frame, 640, x, y);
      if (p[2] > 150 && p[0] < 100 && p[1] < 100)
        textPixels++;
    }
  require(textPixels > 50, "actual HTML text rendered in ordered group");
  png(frame, 640, 360,
      [out stringByAppendingPathComponent:@"mixed-html-native.png"]);
  obs_set_output_source(0, NULL);
  obs_source_dec_showing(root);
  obs_source_dec_active(root);
  obs_source_release(root);
  obs_source_release(panel);
  obs_source_release(live);
  obs_source_release(blue);
  obs_source_release(back);
  obs_source_release(front);
  for (int i = 0;
       i < 200 && (producer_set_v2_live_groups() || atomic_load(&source_live));
       i++)
    usleep(10000);
  require(producer_set_v2_live_groups() == 0 && atomic_load(&source_live) == 0,
          "HTML mixed composition cleanup");
  return @{
    @"actualBrowserSources" : @2,
    @"htmlBelowNative" : @YES,
    @"htmlAboveNative" : @YES,
    @"textPixels" : @(textPixels),
    @"wholeGroupMask" : @YES
  };
}
static void *(*originalMetalCompile)(void *, SEL, void *, void *, NSError **);
static void *traceMetalCompile(id self, SEL sel, NSString *source, id options,
                               NSError **error) {
  NSError *local = nil;
  void *result =
      originalMetalCompile((__bridge void *)self, sel, (__bridge void *)source,
                           (__bridge void *)options, &local);
  if (!result) {
    fprintf(stderr, "METAL COMPILER: %s\nSOURCE:\n%s\n",
            local.description.UTF8String, source.UTF8String);
  }
  if (error)
    *error = local;
  return result;
}
static void shaderDiagnostics(void) {
  if (!getenv("SETS_V2_SHADER_DIAGNOSTICS"))
    return;
  id device = MTLCreateSystemDefaultDevice();
  Method m = class_getInstanceMethod(
      object_getClass(device), @selector(newLibraryWithSource:options:error:));
  if (m)
    originalMetalCompile =
        (void *)method_setImplementation(m, (IMP)traceMetalCompile);
}
static void uiTask(void (*task)(void *), void *param, bool wait);
static int runProbe(int argc, char **argv) {
  @autoreleasepool {
    require(argc == 3, "usage: native-probe app-path output-directory");
    NSString *app = @(argv[1]), *out = @(argv[2]);
    [[NSFileManager defaultManager] createDirectoryAtPath:out
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];

    NSString *graphics = [app stringByAppendingPathComponent:
                                  @"Contents/Frameworks/libobs-metal.dylib"];
    struct video_info v = {graphics.UTF8String,
                           30,
                           1,
                           1920,
                           1080,
                           1920,
                           1080,
                           2,
                           0,
                           true,
                           2,
                           1,
                           3};
    int rc = obs_reset_video(&v);
    require(rc == 0, "video init Metal");
    const struct probe_audio_info audio = {48000, 2};
    require(obs_reset_audio(&audio),
            "initialize isolated audio mixer without capture/output");
    shaderDiagnostics();
    producer_source_appearance_register();
    sets_v2_rust_register();
    register_test();
    if (getenv("PRODUCER_PROBE_SHARPNESS_ONLY")) {
      load_plugin(app,@"obs-browser");obs_post_load_modules();
      NSDictionary *report=sharpness_proof(out);
      [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil] writeToFile:[out stringByAppendingPathComponent:@"sharpness.json"] atomically:YES];
      obs_shutdown();puts("PASS: density-aware native sharpness");return 0;
    }
    require(producer_set_v2_group_create(0, 10, 0, 1) == NULL,
            "reject zero-size group");
    NSMutableArray *checks = [NSMutableArray array];
    for (int orientation = 0; orientation < 2; orientation++) {
      uint32_t w = orientation ? 1080 : 1920, h = orientation ? 1920 : 1080,
               ow = orientation ? 720 : 1280, oh = orientation ? 1280 : 720;
      obs_source_t *blue = solid(w, h, 0, 0, 1, false),
                   *red = solid(w * .8, h * .6, 1, 0, 0, false),
                   *live = solid(400, 300, 0, 1, 0, true),
                   *yellow = solid(100, 100, 1, 1, 0, false);
      NSString *name = orientation ? @"portrait" : @"landscape";
      NSData *planData =
          [NSData dataWithContentsOfFile:
                      [out stringByAppendingPathComponent:
                               [name stringByAppendingString:@"-plan.json"]]];
      require(planData != nil, "read compiled v2 render plan");
      NSDictionary *plan = [NSJSONSerialization JSONObjectWithData:planData
                                                           options:0
                                                             error:nil];
      require(plan != nil, "decode compiled v2 render plan");
      NSDictionary *resources = @{
        @"graphic:blue" : [NSValue valueWithPointer:blue],
        @"graphic:red" : [NSValue valueWithPointer:red],
        @"synthetic-camera" : [NSValue valueWithPointer:live],
        @"graphic:yellow" : [NSValue valueWithPointer:yellow]
      };
      struct producer_set_v2_node descriptor =
          node_descriptor(plan[@"root"], resources, 0);
      char error[200];
      require(!producer_set_v2_scene_prepare(
                  &descriptor, ow, oh, SET_V2_CONTAIN, 1, error, sizeof(error)),
              "whole graph budget preflight rejects before native allocation");
      require(producer_set_v2_live_groups() == 0,
              "budget rejection creates no native groups");
      struct producer_set_v2_scene *scene =
          producer_set_v2_scene_prepare(&descriptor, ow, oh, SET_V2_CONTAIN,
                                        64 * 1024 * 1024, error, sizeof(error));
      if (!scene)
        fprintf(stderr, "scene prepare: %s\n", error);
      require(scene != NULL, "native scene owner prepares compiled fixture");
      free_descriptor(&descriptor);
      obs_source_t *root =
                       obs_source_get_ref(producer_set_v2_scene_source(scene)),
                   *panel = obs_source_get_ref(
                       producer_set_v2_scene_node(scene, "panel"));
      require(root && panel, "actual render plan assembled");
      require(!add(panel, red, 0, 0, 1, 1), "sealed plan immutable");
      obs_source_inc_active(root);
      obs_source_inc_showing(root);
      obs_set_output_source(0, root);
      usleep(140000);
      NSData *a = capture(root, ow, oh, ow, oh);
      color(a, ow, ow * .05, oh * .05, 0, 0, 255, 255, "backdrop");
      color(a, ow, ow * .15, oh * .30, 255, 0, 0, 255, "graphic below live");
      color(a, ow, ow * .40, oh * .50, 0, 255, 0, 255,
            "live source above background");
      color(a, ow, ow * .50, oh * .50, 255, 255, 0, 255, "graphic above live");
      color(a, ow, ow * .10 + 1, oh * .20 + 1, 0, 0, 255, 255,
            "whole-group rounded clipping");
      usleep(210000);
      NSData *b = capture(root, ow, oh, ow, oh);
      require(![a isEqualToData:b],
              "live source advances through masked group");
      NSData *transparent = capture(panel, w * .8, h * .6, 800, 600);
      color(transparent, 800, 1, 1, 0, 0, 0, 0, "transparent corner");
      obs_enter_graphics();
      require(producer_set_v2_group_frame(panel, 80, .5),
              "animate group opacity");
      obs_leave_graphics();
      NSData *half = capture(panel, w * .8, h * .6, 800, 600);
      const uint8_t *alpha = pixel(half, 800, 400, 300);
      require(abs(alpha[3] - 128) <= 3, "group opacity after composition");
      color(half, 800, 400, 300, 128, 128, 0, 128,
            "premultiplied group opacity");
      obs_enter_graphics();
      producer_set_v2_group_frame(panel, 80, 1);
      obs_leave_graphics();
      png(a, ow, oh,
          [out stringByAppendingPathComponent:
                   [name stringByAppendingString:@".png"]]);
      [checks addObject:@{
        @"orientation" : name,
        @"design" : @[ @(w), @(h) ],
        @"output" : @[ @(ow), @(oh) ],
        @"compiledRenderPlan" : @YES,
        @"orderedLayers" : @YES,
        @"maskedMixedGroup" : @YES,
        @"liveFramesAdvance" : @YES,
        @"transparentCorners" : @YES,
        @"groupOpacity" : @YES,
        @"nativeOwner" : @YES,
        @"textureBytes" : @(producer_set_v2_scene_texture_bytes(scene)),
        @"nativeGroups" : @(producer_set_v2_scene_group_count(scene)),
        @"aggregateBudgetRejected" : @YES
      }];
      obs_set_output_source(0, NULL);
      obs_source_dec_showing(root);
      obs_source_dec_active(root);
      obs_source_release(root);
      obs_source_release(panel);
      producer_set_v2_scene_release(scene);
      obs_source_release(blue);
      obs_source_release(red);
      obs_source_release(live);
      obs_source_release(yellow);
      for (int wait = 0; wait < 200 && (producer_set_v2_live_groups() > 0 ||
                                        atomic_load(&source_live) > 0);
           wait++)
        usleep(10000);
      require(producer_set_v2_live_groups() == 0, "all native groups released");
      require(atomic_load(&source_live) == 0, "all synthetic sources released");
    }
    NSDictionary *media = media_proof(app, out);
    NSArray *transitions = transition_proof(out);
    NSArray *program = program_proof(out);
    NSDictionary *owner = owner_proof(out);
    NSDictionary *placement = placement_proof(out);
    NSDictionary *browser = browser_proof(app, out);
    NSArray *adapter = rust_adapter_proof(out);
    NSArray *authored = real_room_proof(out);
    NSDictionary *sharpness = sharpness_proof(out);
    NSDictionary *report = @{
      @"backend" : @"Metal",
      @"obsVersion" : @(obs_get_version_string()),
      @"checks" : checks,
      @"media" : media,
      @"transitions" : transitions,
      @"browser" : browser,
      @"placement" : placement,
      @"sceneOwner" : owner,
      @"program" : program,
      @"appAdapter" : adapter,
      @"authoredRooms" : authored,
      @"sharpness" : sharpness,
      @"remainingGroups" : @(producer_set_v2_live_groups()),
      @"remainingSyntheticSources" : @(atomic_load(&source_live)),
      @"scope" : @"isolated native compositor with synthetic capture, PNG and "
                 @"decoded H.264; actual CEF HTML; no physical capture, room "
                 @"or production integration"
    };
    NSData *json =
        [NSJSONSerialization dataWithJSONObject:report
                                        options:NSJSONWritingPrettyPrinted
                                          error:nil];
    [json writeToFile:[out stringByAppendingPathComponent:@"proof.json"]
           atomically:YES];
    obs_shutdown();
    puts("PASS: native ordered layers, mixed-group masks, live source motion, "
         "opacity, landscape/portrait scaling and cleanup");
    return 0;
  }
}

static void uiTask(void (*task)(void *), void *param, bool wait) {
  if ([NSThread isMainThread])
    task(param);
  else if (wait)
    dispatch_sync(dispatch_get_main_queue(), ^{
      task(param);
    });
  else
    dispatch_async(dispatch_get_main_queue(), ^{
      task(param);
    });
}
int main(int argc, char **argv) {
  @autoreleasepool {
    require(argc == 3, "usage: native-probe app-path output-directory");
    [NSApplication sharedApplication];
    NSString *app = @(argv[1]);
    NSString *resources =
        [app stringByAppendingPathComponent:
                 @"Contents/Frameworks/libobs.framework/Resources/"];
    obs_add_data_path(resources.UTF8String);
    NSString *profile =
        getenv("PRODUCER_PROBE_CONFIG")
            ? @(getenv("PRODUCER_PROBE_CONFIG"))
            : [NSTemporaryDirectory()
                  stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
    [[NSFileManager defaultManager] createDirectoryAtPath:profile
                              withIntermediateDirectories:YES
                                               attributes:nil
                                                    error:nil];
    const char *args[] = {argv[0], "--remote-debugging-port=9436"};
    obs_set_cmdline_args(getenv("SETS_V2_CEF_DEBUG") ? 2 : 1, args);
    require(obs_startup("en-US", profile.UTF8String, NULL), "obs startup");
    obs_set_ui_task_handler(uiTask);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      int result = runProbe(argc, argv);
      exit(result);
    });
    [NSApp run];
    return 1;
  }
}
