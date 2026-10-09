// Real libobs/Metal shader check. No room, camera, recording or network state.
// Usage: test-cutout-refinement /absolute/path/to/libobs-metal.dylib
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <obs.h>
#include <assert.h>
#include <stdio.h>
#include "../src-tauri/src/live/person_mask.effect.h"

static void render(gs_effect_t *effect, gs_texture_t *image, gs_texture_t *mask,
                   gs_texrender_t *target, const char *technique, float strength, uint8_t *pixels)
{
    gs_texrender_reset(target);
    assert(gs_texrender_begin(target, 64, 64));
    gs_matrix_identity();
    gs_ortho(0, 64, 0, 64, -100, 100);
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
    gs_enable_framebuffer_srgb(false); // confidence data, not display color
    gs_effect_set_texture_srgb(gs_effect_get_param_by_name(effect, "image"), image);
    gs_effect_set_texture(gs_effect_get_param_by_name(effect, "mask"), mask);
    struct vec2 texel = {1.0f / 8, 1.0f / 8};
    gs_effect_set_vec2(gs_effect_get_param_by_name(effect, "mask_texel"), &texel);
    struct vec2 fine_texel = {1.0f / 64, 1.0f / 64};
    gs_effect_set_vec2(gs_effect_get_param_by_name(effect, "refine_texel"), &fine_texel);
    gs_effect_set_float(gs_effect_get_param_by_name(effect, "edge_refine"), strength);
    gs_effect_set_float(gs_effect_get_param_by_name(effect, "feather"), 0.35f);
    gs_effect_set_float(gs_effect_get_param_by_name(effect, "erode"), 2.0f);
    gs_technique_t *tech = gs_effect_get_technique(effect, technique);
    assert(gs_technique_begin(tech) == 1);
    assert(gs_technique_begin_pass(tech, 0));
    gs_draw_sprite(image, 0, 64, 64);
    gs_technique_end_pass(tech);
    gs_technique_end(tech);
    gs_texrender_end(target);
    gs_stagesurf_t *stage = gs_stagesurface_create(64, 64, GS_BGRA);
    gs_stage_texture(stage, gs_texrender_get_texture(target));
    uint8_t *data;
    uint32_t stride;
    assert(gs_stagesurface_map(stage, &data, &stride));
    for (int y = 0; y < 64; y++) memcpy(pixels + y * 64 * 4, data + y * stride, 64 * 4);
    gs_stagesurface_unmap(stage);
    gs_stagesurface_destroy(stage);
}

int main(int argc, const char **argv)
{
    @autoreleasepool {
        assert(argc == 2);
        assert(obs_startup("en-US", NULL, NULL));
        graphics_t *graphics = NULL;
        assert(gs_create(&graphics, argv[1], 0) == GS_SUCCESS);
        gs_enter_context(graphics);
        char *error = NULL;
        gs_effect_t *effect = gs_effect_create(PRODUCER_PERSON_MASK_EFFECT, "cutout-refinement-test", &error);
        if (!effect) { fprintf(stderr, "%s\n", error ?: "shader compilation failed"); return 1; }
        uint8_t image[64 * 64 * 4], flat[8 * 8], ramp[8 * 8];
        const uint8_t levels[8] = {0, 0, 32, 96, 160, 224, 255, 255};
        for (int y = 0; y < 64; y++) for (int x = 0; x < 64; x++) {
            int i = (y * 64 + x) * 4;
            image[i] = image[i + 1] = image[i + 2] = x < 32 ? 0 : 255;
            image[i + 3] = 255;
        }
        for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
            flat[y * 8 + x] = 128;
            ramp[y * 8 + x] = levels[x];
        }
        const uint8_t *image_data = image, *flat_data = flat, *ramp_data = ramp;
        gs_texture_t *camera = gs_texture_create(64, 64, GS_BGRA, 1, &image_data, 0);
        gs_texture_t *constant_mask = gs_texture_create(8, 8, GS_R8, 1, &flat_data, 0);
        gs_texture_t *ramp_mask = gs_texture_create(8, 8, GS_R8, 1, &ramp_data, 0);
        id<MTLTexture> input_mask = (__bridge id<MTLTexture>)gs_texture_get_obj(constant_mask);
        uint8_t mask_pixels[64];
        [input_mask getBytes:mask_pixels bytesPerRow:8 fromRegion:MTLRegionMake2D(0, 0, 8, 8) mipmapLevel:0];
        for (int i = 0; i < 64; i++) assert(mask_pixels[i] == 128);
        gs_texrender_t *target = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
        uint8_t flat_output[64 * 64 * 4], baseline[64 * 64 * 4], refined[64 * 64 * 4];
        render(effect, camera, constant_mask, target, "Refine", 1.0f, flat_output);
        for (int i = 0; i < 64 * 64; i++) assert(abs((int)flat_output[i * 4] - 128) <= 1);
        render(effect, camera, ramp_mask, target, "Refine", 0.0f, baseline);
        render(effect, camera, ramp_mask, target, "Refine", 1.0f, refined);
        int left = (32 * 64 + 31) * 4, right = (32 * 64 + 32) * 4;
        assert(refined[left] < baseline[left]);
        assert(refined[right] > baseline[right]);
        uint8_t thin_image[64 * 64 * 4], thin_mask[8 * 8];
        for (int y = 0; y < 64; y++) for (int x = 0; x < 64; x++) {
            int i = (y * 64 + x) * 4;
            thin_image[i] = thin_image[i + 1] = thin_image[i + 2] = x >= 32 && x < 40 ? 255 : 0;
            thin_image[i + 3] = 255;
        }
        for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) thin_mask[y * 8 + x] = x == 4 ? 255 : 0;
        const uint8_t *thin_image_data = thin_image, *thin_mask_data = thin_mask;
        gs_texture_t *thin_camera = gs_texture_create(64, 64, GS_BGRA, 1, &thin_image_data, 0);
        gs_texture_t *thin_native = gs_texture_create(8, 8, GS_R8, 1, &thin_mask_data, 0);
        gs_texrender_t *fine_target = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
        uint8_t thin_baseline[64 * 64 * 4], thin_refined[64 * 64 * 4];
        render(effect, thin_camera, thin_native, target, "Cut", 0.0f, thin_baseline);
        render(effect, thin_camera, thin_native, fine_target, "Refine", 1.0f, flat_output);
        render(effect, thin_camera, gs_texrender_get_texture(fine_target), target, "Cut", 1.0f, thin_refined);
        int finger = (32 * 64 + 36) * 4 + 3;
        assert(thin_baseline[finger] == 0 && thin_refined[finger] > 200);
        printf("PASS: real Metal shader; confidence 0.5 stays linear; background edge %d -> %d, foreground edge %d -> %d\n",
               baseline[left], refined[left], baseline[right], refined[right]);
        printf("PASS: high-contrast thin feature alpha %d -> %d at the same Erode setting\n", thin_baseline[finger], thin_refined[finger]);
        gs_texrender_destroy(fine_target);
        gs_texture_destroy(thin_camera);
        gs_texture_destroy(thin_native);
        gs_texrender_destroy(target);
        gs_texture_destroy(camera);
        gs_texture_destroy(constant_mask);
        gs_texture_destroy(ramp_mask);
        gs_effect_destroy(effect);
        if (error) bfree(error);
        gs_leave_context();
        gs_destroy(graphics);
        obs_shutdown();
    }
    return 0;
}
