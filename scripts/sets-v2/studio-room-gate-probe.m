#import <AppKit/AppKit.h>
#include "obs_min.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern void producer_studio_room_gate_register(void);
extern bool producer_studio_room_gate_require_capture(obs_source_t *, obs_source_t *);
extern bool obs_startup(const char *, const char *, void *);
extern void obs_shutdown(void);
extern void obs_add_data_path(const char *);
typedef struct obs_scene obs_scene_t;
extern obs_scene_t *obs_scene_create_private(const char *);
extern obs_source_t *obs_scene_get_source(const obs_scene_t *);
extern void *obs_scene_add(obs_scene_t *, obs_source_t *);
extern void obs_scene_release(obs_scene_t *);
extern obs_source_t *obs_get_output_source(uint32_t);
extern void obs_set_output_source(uint32_t, obs_source_t *);
extern void obs_source_filter_add(obs_source_t *, obs_source_t *);
extern void obs_source_filter_remove(obs_source_t *, obs_source_t *);
extern bool obs_source_active(const obs_source_t *);
extern void obs_add_main_render_callback(void (*)(void *, uint32_t, uint32_t), void *);
extern void obs_remove_main_render_callback(void (*)(void *, uint32_t, uint32_t), void *);
struct video_info {
	const char *graphics_module;
	uint32_t fps_num, fps_den, base_width, base_height, output_width, output_height;
	int output_format;
	uint32_t adapter;
	bool gpu_conversion;
	int colorspace, range, scale_type;
};
extern int obs_reset_video(struct video_info *);

static atomic_uint frames, room_draws, studio_draws;
static unsigned offscreen_draws;
static gs_texrender_t *offscreen;
static const char *name(void *unused) { return "Room draw counter"; }
static void *create(obs_data_t *unused, obs_source_t *source) { return source; }
static void destroy(void *unused) {}
static obs_source_t *room_counter, *studio_counter;
static atomic_bool studio_ready;
static uint32_t axis(void *source) { return source == studio_counter && !atomic_load(&studio_ready) ? 0 : 1280; }

static void draw(void *source, gs_effect_t *unused)
{
	if (source == room_counter)
		atomic_fetch_add(&room_draws, 1);
	if (source == studio_counter && atomic_load(&studio_ready))
		atomic_fetch_add(&studio_draws, 1);
}

// Run on the graphics thread. Emulate a thumbnail/auxiliary consumer
// drawing channel 0 into a distinct texture while the Studio gate is active.
static void before_main(void *room, uint32_t w, uint32_t h)
{
	if (!offscreen)
		offscreen = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
	gs_texrender_reset(offscreen);
	if (gs_texrender_begin(offscreen, 80, 45)) {
		unsigned before = atomic_load(&room_draws);
		obs_source_video_render(room);
		if (atomic_load(&room_draws) > before)
			offscreen_draws++;
		gs_texrender_end(offscreen);
	}
	atomic_fetch_add(&frames, 1);
}

static void require(bool value, const char *stage)
{
	if (!value) {
		fprintf(stderr, "FAIL: %s\n", stage);
		exit(2);
	}
}
static void measure(obs_source_t *room, const char *phase, bool gated)
{
	obs_enter_graphics();
	atomic_store(&frames, 0);
	atomic_store(&room_draws, 0);
	atomic_store(&studio_draws, 0);
	offscreen_draws = 0;
	obs_leave_graphics();
	for (int i = 0; i < 120 && atomic_load(&frames) < 30; i++)
		usleep(20000);
	obs_enter_graphics();
	unsigned ticks=atomic_load(&frames), room_count=atomic_load(&room_draws);
	unsigned studio_count=atomic_load(&studio_draws), offscreen_count=offscreen_draws;
	bool active = obs_source_active(room) && obs_source_active(room_counter);
	obs_leave_graphics();
	printf("%s ticks=%u room_draws=%u studio_draws=%u auxiliary_draws=%u active=%d\n",
	       phase, ticks, room_count, studio_count, offscreen_count, active);
	require(ticks >= 30 && offscreen_count == ticks && active, "room kept its activity and offscreen draws");
	require(gated ? (room_count == ticks && studio_count+1 >= ticks)
		      : (room_count+1 >= 2*ticks && studio_count == 0),
		"main room draw skipped only for Studio");
}

int main(int argc, char **argv)
{
	@autoreleasepool {
		require(argc == 4, "usage: app-path metal|opengl temp-profile");
		[NSApplication sharedApplication];
		NSString *frameworks=[@(argv[1]) stringByAppendingPathComponent:@"Contents/Frameworks"];
		NSString *res=[frameworks stringByAppendingPathComponent:@"libobs.framework/Resources"];
		NSString *backend=[frameworks stringByAppendingPathComponent:[NSString stringWithFormat:@"libobs-%s.dylib",argv[2]]];
		obs_add_data_path(res.UTF8String);
		require(obs_startup("en-US",argv[3],NULL), "OBS startup");
		struct video_info info={backend.UTF8String, 60, 1, 1920,1080,1920,1080,2,0,true,2,1,3};
		require(obs_reset_video(&info)==0, "graphics startup");
		struct obs_source_info counter={0};
		counter.id="draw_counter"; counter.type=OBS_SOURCE_TYPE_INPUT;
		counter.output_flags=OBS_SOURCE_VIDEO|OBS_SOURCE_CUSTOM_DRAW|OBS_SOURCE_SRGB;
		counter.get_name=name; counter.create=create; counter.destroy=destroy;
		counter.get_width=axis; counter.get_height=axis; counter.video_render=draw;
		obs_register_source_s(&counter,sizeof(counter));
		producer_studio_room_gate_register();
		room_counter=obs_source_create_private("draw_counter","room counter",NULL);
		studio_counter=obs_source_create_private("draw_counter","studio counter",NULL);
		obs_scene_t *room_scene=obs_scene_create_private("room");
		require(room_counter && studio_counter && room_scene, "sources created");
		require(obs_scene_add(room_scene,room_counter)!=NULL, "room input attached");
		obs_source_t *room=obs_scene_get_source(room_scene);
		obs_source_t *gate=obs_source_create_private("producer_studio_room_program_gate","gate",NULL);
		require(gate!=NULL, "gate created");
		obs_set_output_source(0,room);
		obs_add_main_render_callback(before_main,room);
		measure(room,"room-only",false);
		require(producer_studio_room_gate_require_capture(gate,studio_counter), "capture readiness check installed");
		obs_set_output_source(2,studio_counter);
		obs_enter_graphics();
		obs_source_filter_add(room,gate);
		obs_leave_graphics();
		measure(room,"capture-warming",false);
		atomic_store(&studio_ready,true);
		measure(room,"capture-ready",true);
		atomic_store(&studio_ready,false);
		measure(room,"capture-lost",false);
		obs_enter_graphics();
		obs_source_filter_remove(room,gate);
		obs_leave_graphics();
		obs_set_output_source(2,NULL);
		measure(room,"room-restored",false);
		obs_remove_main_render_callback(before_main,room);
		obs_enter_graphics();
		gs_texrender_destroy(offscreen);
		obs_leave_graphics();
		obs_set_output_source(0,NULL);
		obs_source_release(gate);
		obs_source_release(room_counter);
		obs_source_release(studio_counter);
		obs_scene_release(room_scene);
		obs_shutdown();
		puts("PASS");
		return 0;
	}
}
