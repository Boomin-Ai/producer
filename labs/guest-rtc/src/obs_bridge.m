// Diagnostic bridge, pinned to OBS 32.1.2 source-frame/audio layouts.
// Source: https://github.com/obsproject/obs-studio/tree/32.1.2/libobs
#import <Cocoa/Cocoa.h>
#include <stdlib.h>
#include "../../../src-tauri/src/live/guest_ingest.h"
extern uint64_t os_gettime_ns(void);
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
    producer_guest_ingest_register();
}
void guest_obs_pump(void) {
    @autoreleasepool { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, true); }
}
uint64_t guest_obs_now_ns(void) { return os_gettime_ns(); }

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
