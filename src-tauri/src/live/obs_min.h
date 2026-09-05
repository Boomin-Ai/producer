/* Minimal hand-written libobs C surface for the native filters the shim
 * registers (person mask). Mirrors what ffi.rs does for Rust: the engine's
 * own headers live in engine/obs-studio/, which is gitignored and absent on
 * the release runners, so the shim declares exactly what it calls.
 *
 * Pinned to engine/obs.lock: 32.1.2 / fb4d98bf. `struct obs_source_info` is
 * copied field-for-field from libobs/obs-source.h at that tag; registration
 * passes sizeof() so libobs rejects a size it does not know rather than
 * reading past the end. Re-diff against obs-source.h on every lock bump.
 */
#ifndef PRODUCER_OBS_MIN_H
#define PRODUCER_OBS_MIN_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct obs_source obs_source_t;
typedef struct obs_data obs_data_t;
typedef struct obs_properties obs_properties_t;
typedef struct obs_property obs_property_t;
typedef struct gs_effect gs_effect_t;
typedef struct gs_effect_param gs_eparam_t;
typedef struct gs_effect_technique gs_technique_t;
typedef struct gs_texture gs_texture_t;
typedef struct gs_texture_render gs_texrender_t;
typedef struct gs_stage_surface gs_stagesurf_t;

/* libobs/obs-source.h */
enum obs_source_type {
	OBS_SOURCE_TYPE_INPUT,
	OBS_SOURCE_TYPE_FILTER,
	OBS_SOURCE_TYPE_TRANSITION,
	OBS_SOURCE_TYPE_SCENE,
};
#define OBS_SOURCE_VIDEO (1 << 0)
#define OBS_SOURCE_SRGB (1 << 15)

/* libobs/obs.h */
enum obs_allow_direct_render {
	OBS_NO_DIRECT_RENDERING,
	OBS_ALLOW_DIRECT_RENDERING,
};
enum obs_base_effect {
	OBS_EFFECT_DEFAULT,
};

/* libobs/graphics/graphics.h */
enum gs_color_format {
	GS_UNKNOWN,
	GS_A8,
	GS_R8,
	GS_RGBA,
	GS_BGRX,
	GS_BGRA,
	GS_R10G10B10A2,
	GS_RGBA16,
	GS_R16,
	GS_RGBA16F,
	GS_RGBA32F,
	GS_RG16F,
	GS_RG32F,
	GS_R16F,
	GS_R32F,
	GS_DXT1,
	GS_DXT3,
	GS_DXT5,
	GS_R8G8,
	GS_RGBA_UNORM,
	GS_BGRX_UNORM,
	GS_BGRA_UNORM,
	GS_RG16,
};
enum gs_zstencil_format {
	GS_ZS_NONE,
};
enum gs_color_space {
	GS_CS_SRGB,
	GS_CS_SRGB_16F,
	GS_CS_709_EXTENDED,
	GS_CS_709_SCRGB,
};
enum gs_blend_type {
	GS_BLEND_ZERO,
	GS_BLEND_ONE,
	GS_BLEND_SRCCOLOR,
	GS_BLEND_INVSRCCOLOR,
	GS_BLEND_SRCALPHA,
	GS_BLEND_INVSRCALPHA,
};
#define GS_CLEAR_COLOR (1 << 0)
#define GS_DEVICE_OPENGL 1
#define GS_DEVICE_DIRECT3D_11 2
#define GS_DEVICE_METAL 3

/* libobs/obs-properties.h */
enum obs_combo_format {
	OBS_COMBO_FORMAT_INVALID,
	OBS_COMBO_FORMAT_INT,
	OBS_COMBO_FORMAT_FLOAT,
	OBS_COMBO_FORMAT_STRING,
};
enum obs_combo_type {
	OBS_COMBO_TYPE_INVALID,
	OBS_COMBO_TYPE_EDITABLE,
	OBS_COMBO_TYPE_LIST,
};

/* libobs/util/base.h */
#define LOG_ERROR 100
#define LOG_WARNING 200
#define LOG_INFO 300
#define LOG_DEBUG 400

struct vec2 {
	float x, y;
};
/* libobs' vec4 carries an __m128 in its union: 16 bytes, 16-aligned. */
struct vec4 {
	float x, y, z, w;
}
#if defined(_MSC_VER)
;
#else
__attribute__((aligned(16)));
#endif

/* libobs/obs-source.h at 32.1.2 — every field, in order. Types the filter
 * never touches are declared as void* to keep this header self-contained;
 * a function pointer's size does not depend on its signature. */
struct obs_source_info {
	const char *id;
	enum obs_source_type type;
	uint32_t output_flags;
	const char *(*get_name)(void *type_data);
	void *(*create)(obs_data_t *settings, obs_source_t *source);
	void (*destroy)(void *data);
	uint32_t (*get_width)(void *data);
	uint32_t (*get_height)(void *data);
	void (*get_defaults)(obs_data_t *settings);
	obs_properties_t *(*get_properties)(void *data);
	void (*update)(void *data, obs_data_t *settings);
	void (*activate)(void *data);
	void (*deactivate)(void *data);
	void (*show)(void *data);
	void (*hide)(void *data);
	void (*video_tick)(void *data, float seconds);
	void (*video_render)(void *data, gs_effect_t *effect);
	void *(*filter_video)(void *data, void *frame);
	void *(*filter_audio)(void *data, void *audio);
	void (*enum_active_sources)(void *data, void *enum_callback, void *param);
	void (*save)(void *data, obs_data_t *settings);
	void (*load)(void *data, obs_data_t *settings);
	void (*mouse_click)(void *data, const void *event, int32_t type, bool mouse_up, uint32_t click_count);
	void (*mouse_move)(void *data, const void *event, bool mouse_leave);
	void (*mouse_wheel)(void *data, const void *event, int x_delta, int y_delta);
	void (*focus)(void *data, bool focus);
	void (*key_click)(void *data, const void *event, bool key_up);
	void (*filter_remove)(void *data, obs_source_t *source);
	void *type_data;
	void (*free_type_data)(void *type_data);
	bool (*audio_render)(void *data, uint64_t *ts_out, void *audio_output, uint32_t mixers, size_t channels,
			     size_t sample_rate);
	void (*enum_all_sources)(void *data, void *enum_callback, void *param);
	void (*transition_start)(void *data);
	void (*transition_stop)(void *data);
	void (*get_defaults2)(void *type_data, obs_data_t *settings);
	obs_properties_t *(*get_properties2)(void *data, void *type_data);
	bool (*audio_mix)(void *data, uint64_t *ts_out, void *audio_output, size_t channels, size_t sample_rate);
	int icon_type; /* enum obs_icon_type */
	void (*media_play_pause)(void *data, bool pause);
	void (*media_restart)(void *data);
	void (*media_stop)(void *data);
	void (*media_next)(void *data);
	void (*media_previous)(void *data);
	int64_t (*media_get_duration)(void *data);
	int64_t (*media_get_time)(void *data);
	void (*media_set_time)(void *data, int64_t miliseconds);
	int (*media_get_state)(void *data); /* enum obs_media_state */
	uint32_t version;
	const char *unversioned_id;
	void *(*missing_files)(void *data);
	enum gs_color_space (*video_get_color_space)(void *data, size_t count, const enum gs_color_space *preferred_spaces);
	void (*filter_add)(void *data, obs_source_t *source);
};

#if defined(_WIN32)
#define OBS_IMPORT __declspec(dllimport)
#else
#define OBS_IMPORT
#endif

OBS_IMPORT void obs_register_source_s(const struct obs_source_info *info, size_t size);
OBS_IMPORT void blog(int log_level, const char *format, ...);
OBS_IMPORT void bfree(void *ptr);

OBS_IMPORT obs_source_t *obs_filter_get_target(const obs_source_t *filter);
OBS_IMPORT obs_source_t *obs_filter_get_parent(const obs_source_t *filter);
OBS_IMPORT uint32_t obs_source_get_base_width(obs_source_t *source);
OBS_IMPORT uint32_t obs_source_get_base_height(obs_source_t *source);
OBS_IMPORT void obs_source_video_render(obs_source_t *source);
OBS_IMPORT void obs_source_skip_video_filter(obs_source_t *filter);
OBS_IMPORT enum gs_color_space obs_source_get_color_space(obs_source_t *source, size_t count,
							  const enum gs_color_space *preferred_spaces);
OBS_IMPORT void obs_enter_graphics(void);
OBS_IMPORT void obs_leave_graphics(void);
OBS_IMPORT gs_effect_t *obs_get_base_effect(enum obs_base_effect effect);

OBS_IMPORT const char *obs_data_get_string(obs_data_t *data, const char *name);
OBS_IMPORT double obs_data_get_double(obs_data_t *data, const char *name);
OBS_IMPORT void obs_data_set_default_string(obs_data_t *data, const char *name, const char *val);
OBS_IMPORT void obs_data_set_default_double(obs_data_t *data, const char *name, double val);

OBS_IMPORT obs_properties_t *obs_properties_create(void);
OBS_IMPORT obs_property_t *obs_properties_add_list(obs_properties_t *props, const char *name, const char *description,
						   enum obs_combo_type type, enum obs_combo_format format);
OBS_IMPORT size_t obs_property_list_add_string(obs_property_t *p, const char *name, const char *val);
OBS_IMPORT obs_property_t *obs_properties_add_float_slider(obs_properties_t *props, const char *name,
							   const char *description, double min, double max,
							   double step);

OBS_IMPORT gs_effect_t *gs_effect_create(const char *effect_string, const char *filename, char **error_string);
OBS_IMPORT void gs_effect_destroy(gs_effect_t *effect);
OBS_IMPORT gs_eparam_t *gs_effect_get_param_by_name(const gs_effect_t *effect, const char *name);
OBS_IMPORT gs_technique_t *gs_effect_get_technique(const gs_effect_t *effect, const char *name);
OBS_IMPORT void gs_effect_set_texture(gs_eparam_t *param, gs_texture_t *val);
OBS_IMPORT void gs_effect_set_texture_srgb(gs_eparam_t *param, gs_texture_t *val);
OBS_IMPORT void gs_effect_set_float(gs_eparam_t *param, float val);
OBS_IMPORT void gs_effect_set_vec2(gs_eparam_t *param, const struct vec2 *val);
OBS_IMPORT size_t gs_technique_begin(gs_technique_t *technique);
OBS_IMPORT void gs_technique_end(gs_technique_t *technique);
OBS_IMPORT bool gs_technique_begin_pass(gs_technique_t *technique, size_t pass);
OBS_IMPORT void gs_technique_end_pass(gs_technique_t *technique);
OBS_IMPORT void gs_draw_sprite(gs_texture_t *tex, uint32_t flip, uint32_t width, uint32_t height);

OBS_IMPORT gs_texrender_t *gs_texrender_create(enum gs_color_format format, enum gs_zstencil_format zsformat);
OBS_IMPORT void gs_texrender_destroy(gs_texrender_t *texrender);
OBS_IMPORT bool gs_texrender_begin(gs_texrender_t *texrender, uint32_t cx, uint32_t cy);
OBS_IMPORT bool gs_texrender_begin_with_color_space(gs_texrender_t *texrender, uint32_t cx, uint32_t cy,
						    enum gs_color_space space);
OBS_IMPORT void gs_texrender_end(gs_texrender_t *texrender);
OBS_IMPORT void gs_texrender_reset(gs_texrender_t *texrender);
OBS_IMPORT gs_texture_t *gs_texrender_get_texture(const gs_texrender_t *texrender);

OBS_IMPORT void gs_texture_destroy(gs_texture_t *tex);
OBS_IMPORT uint32_t gs_texture_get_width(const gs_texture_t *tex);
OBS_IMPORT uint32_t gs_texture_get_height(const gs_texture_t *tex);
OBS_IMPORT void *gs_texture_get_obj(gs_texture_t *tex);
#if defined(__APPLE__)
OBS_IMPORT gs_texture_t *gs_texture_create_from_iosurface(void *iosurf);
#endif

OBS_IMPORT gs_stagesurf_t *gs_stagesurface_create(uint32_t width, uint32_t height, enum gs_color_format color_format);
OBS_IMPORT void gs_stagesurface_destroy(gs_stagesurf_t *stagesurf);
OBS_IMPORT void gs_stage_texture(gs_stagesurf_t *dst, gs_texture_t *src);
OBS_IMPORT bool gs_stagesurface_map(gs_stagesurf_t *stagesurf, uint8_t **data, uint32_t *linesize);
OBS_IMPORT void gs_stagesurface_unmap(gs_stagesurf_t *stagesurf);

OBS_IMPORT int gs_get_device_type(void);
OBS_IMPORT enum gs_color_format gs_get_format_from_space(enum gs_color_space space);
OBS_IMPORT void gs_clear(uint32_t clear_flags, const struct vec4 *color, float depth, uint8_t stencil);
OBS_IMPORT void gs_ortho(float left, float right, float top, float bottom, float znear, float zfar);
OBS_IMPORT void gs_blend_state_push(void);
OBS_IMPORT void gs_blend_state_pop(void);
OBS_IMPORT void gs_blend_function(enum gs_blend_type src, enum gs_blend_type dest);
OBS_IMPORT void gs_blend_function_separate(enum gs_blend_type src_c, enum gs_blend_type dest_c,
					   enum gs_blend_type src_a, enum gs_blend_type dest_a);
OBS_IMPORT void gs_enable_framebuffer_srgb(bool enable);
OBS_IMPORT bool gs_framebuffer_srgb_enabled(void);
OBS_IMPORT bool gs_get_linear_srgb(void);
OBS_IMPORT bool gs_set_linear_srgb(bool linear_srgb);
OBS_IMPORT void gs_viewport_push(void);
OBS_IMPORT void gs_viewport_pop(void);
OBS_IMPORT void gs_projection_push(void);
OBS_IMPORT void gs_projection_pop(void);
OBS_IMPORT void gs_set_viewport(int x, int y, int width, int height);
OBS_IMPORT void gs_matrix_push(void);
OBS_IMPORT void gs_matrix_pop(void);
OBS_IMPORT void gs_matrix_identity(void);

/* Shared by both shims: the filter id the frontend catalog and filters.rs
 * know. Keep the three in step. */
#define PRODUCER_PERSON_MASK_ID "producer_person_mask"

#ifdef __cplusplus
}
#endif

#endif /* PRODUCER_OBS_MIN_H */
