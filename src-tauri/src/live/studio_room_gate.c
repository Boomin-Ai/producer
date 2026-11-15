/* The main canvas still owns the room's audio/source tree in Studio mode.
 * Suppress only its hidden video draw: the opaque Studio scene is painted
 * immediately afterwards. Previews and auxiliary mixes use separate targets. */
#include "obs_min.h"
#include <stdlib.h>

OBS_IMPORT gs_texture_t *obs_get_main_texture(void);
OBS_IMPORT gs_texture_t *gs_get_render_target(void);

struct room_gate {
	obs_source_t *filter;
	/* Borrowed for the gate's lifetime; the owner holds a strong ref. */
	obs_source_t *required_capture;
};

static const char *room_gate_name(void *unused)
{
	(void)unused;
	return "Studio room program video gate";
}

static void *room_gate_create(obs_data_t *settings, obs_source_t *source)
{
	(void)settings;
	struct room_gate *gate = calloc(1, sizeof(*gate));
	if (gate)
		gate->filter = source;
	return gate;
}

static void room_gate_destroy(void *data)
{
	free(data);
}

static void room_gate_render(void *data, gs_effect_t *effect)
{
	(void)effect;
	struct room_gate *gate = data;
	gs_texture_t *main = obs_get_main_texture();
	/* On the first frame after a reset libobs has not exposed this texture
	 * yet. Also keep the room visible while async capture is starting or
	 * has stopped: the Studio window is not yet covering the room. */
	if (!main || gs_get_render_target() != main ||
	    (gate->required_capture && obs_source_get_width(gate->required_capture) == 0))
		obs_source_skip_video_filter(gate->filter);
}

bool producer_studio_room_gate_require_capture(obs_source_t *filter, obs_source_t *capture)
{
	struct room_gate *gate = obs_obj_get_data(filter);
	if (!gate)
		return false;
	gate->required_capture = capture;
	return true;
}

void producer_studio_room_gate_register(void)
{
	struct obs_source_info info = {0};
	info.id = "producer_studio_room_program_gate";
	info.type = OBS_SOURCE_TYPE_FILTER;
	info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
	info.get_name = room_gate_name;
	info.create = room_gate_create;
	info.destroy = room_gate_destroy;
	info.video_render = room_gate_render;
	obs_register_source_s(&info, sizeof(info));
}
