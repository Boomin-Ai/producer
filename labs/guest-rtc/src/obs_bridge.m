// Diagnostic bridge, pinned to OBS 32.1.2 source-frame/audio layouts.
// Source: https://github.com/obsproject/obs-studio/tree/32.1.2/libobs
#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include "../../../src-tauri/src/live/obs_min.h"
#define MAX_AV_PLANES 8
struct obs_source_frame {
    uint8_t *data[MAX_AV_PLANES]; uint32_t linesize[MAX_AV_PLANES];
    uint32_t width, height; uint64_t timestamp;
    int format; float color_matrix[16]; bool full_range; uint16_t max_luminance;
    float color_range_min[3], color_range_max[3]; bool flip; uint8_t flags, trc;
    volatile long refs; bool prev_frame;
};
struct obs_source_audio {
    const uint8_t *data[MAX_AV_PLANES]; uint32_t frames;
    int speakers, format; uint32_t samples_per_sec; uint64_t timestamp;
};
extern void obs_source_output_video(obs_source_t *, const struct obs_source_frame *);
extern void obs_source_output_audio(obs_source_t *, const struct obs_source_audio *);
extern bool video_format_get_parameters(int, int, float[16], float[3], float[3]);
extern uint64_t os_gettime_ns(void);
static const char *name(void *unused) { return "Guest timing proof"; }
static void *create(obs_data_t *settings, obs_source_t *source) { return source; }
static void destroy(void *unused) {}
typedef void (*obs_task)(void *);
extern void obs_set_ui_task_handler(void (*handler)(obs_task, void *, bool));
struct ui_context { obs_task task; void *param; };
static void run_ui(void *pointer) { struct ui_context *ctx = pointer; ctx->task(ctx->param); free(ctx); }
static void ui_handler(obs_task task, void *param, bool wait) {
    if ([NSThread isMainThread]) { task(param); return; }
    struct ui_context *ctx = malloc(sizeof(*ctx)); ctx->task = task; ctx->param = param;
    if (wait) dispatch_sync_f(dispatch_get_main_queue(), ctx, run_ui);
    else dispatch_async_f(dispatch_get_main_queue(), ctx, run_ui);
}
void guest_obs_init_main(void) { [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited]; }
void guest_obs_register(void) {
    obs_set_ui_task_handler(ui_handler);
    struct obs_source_info info = {0};
    info.id = "producer_guest_timing_proof"; info.type = OBS_SOURCE_TYPE_INPUT;
    info.output_flags = (1 << 0) | (1 << 1) | (1 << 2); // video, audio, async
    info.get_name = name; info.create = create; info.destroy = destroy;
    obs_register_source_s(&info, sizeof(info));
}
void guest_obs_pump(void) {
    @autoreleasepool { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, true); }
}
uint64_t guest_obs_now_ns(void) { return os_gettime_ns(); }
void guest_obs_video(obs_source_t *source, const uint8_t *y, const uint8_t *u,
                     const uint8_t *v, uint32_t width, uint32_t height,
                     uint32_t ys, uint32_t us, uint32_t vs, uint64_t timestamp) {
    struct obs_source_frame frame = {0};
    frame.data[0] = (uint8_t *)y; frame.data[1] = (uint8_t *)u; frame.data[2] = (uint8_t *)v;
    frame.linesize[0] = ys; frame.linesize[1] = us; frame.linesize[2] = vs;
    frame.width = width; frame.height = height; frame.timestamp = timestamp;
    frame.format = 1; // I420
    video_format_get_parameters(2, 1, frame.color_matrix, frame.color_range_min, frame.color_range_max);
    obs_source_output_video(source, &frame); // libobs copies before return
}
void guest_obs_audio(obs_source_t *source, const int16_t *pcm, uint32_t samples, uint32_t channels,
                     uint64_t timestamp) {
    struct obs_source_audio audio = {0};
    audio.data[0] = (const uint8_t *)pcm; audio.frames = samples;
    audio.speakers = channels == 2 ? 2 : 1; audio.format = 2; audio.samples_per_sec = 48000;
    audio.timestamp = timestamp; obs_source_output_audio(source, &audio);
}

#include <mach/mach.h>
#include <dirent.h>
uint64_t guest_obs_thread_count(void) {
    thread_act_array_t threads = NULL; mach_msg_type_number_t count = 0;
    if (task_threads(mach_task_self(), &threads, &count) != KERN_SUCCESS) return UINT64_MAX;
    for (mach_msg_type_number_t i = 0; i < count; ++i) mach_port_deallocate(mach_task_self(), threads[i]);
    vm_deallocate(mach_task_self(), (vm_address_t)threads, count * sizeof(thread_t));
    return count;
}
uint64_t guest_obs_fd_count(void) {
    DIR *directory = opendir("/dev/fd"); if (!directory) return UINT64_MAX;
    uint64_t count = 0; struct dirent *entry;
    while ((entry = readdir(directory))) if (entry->d_name[0] != '.') ++count;
    closedir(directory); return count;
}
