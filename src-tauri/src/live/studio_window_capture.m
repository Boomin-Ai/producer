// Keep extra capture pixels for close-ups, then fit the visible room into
// the program canvas in one graphics pass.
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <os/lock.h>

#include <math.h>
#include <stdatomic.h>
#include <string.h>
#include "obs_min.h"

extern long long obs_data_get_int(obs_data_t *, const char *);
extern bool gs_texture_rebind_iosurface(gs_texture_t *, void *);
extern bool gs_effect_loop(gs_effect_t *, const char *);
extern void gs_render_start(bool);
extern void gs_vertex2f(float, float);
extern void gs_vertex3f(float, float, float);
extern void gs_texcoord(float, float, int);
extern void gs_color(uint32_t);
typedef struct gs_vertex_buffer gs_vertbuffer_t;
extern gs_vertbuffer_t *gs_render_save(void);
extern void gs_vertexbuffer_destroy(gs_vertbuffer_t *);
extern void gs_load_vertexbuffer(gs_vertbuffer_t *);
extern void gs_load_indexbuffer(void *);
extern void gs_draw(int, uint32_t, uint32_t);
extern uint64_t os_gettime_ns(void);
extern obs_source_t *obs_get_output_source(uint32_t channel);
extern gs_texture_t *obs_get_main_texture(void);
extern gs_texture_t *gs_get_render_target(void);
extern void obs_add_main_render_callback(void (*callback)(void *, uint32_t, uint32_t), void *);
extern void obs_remove_main_render_callback(void (*callback)(void *, uint32_t, uint32_t), void *);

// Pinned libobs/obs.h and libobs/graphics/graphics.h, like obs_min.h.
enum { studio_rect_effect = 1, studio_solid_effect = 3, studio_tri_strip = 4 };
enum { studio_motion_max_keys = 1200 };

struct capture_frame {
    IOSurfaceRef surface;
    CGRect content_pixels;
    CMTime timestamp;
};

struct studio_plane {
    float x, y, width, height, tilt, pitch, roll;
};

struct studio_projection {
    float x, y, xx, xy, yx, yy, depth_x, depth_y;
};

struct studio_pose {
    float crop[4];
    float lift, floating, zoom, pan_x, pan_y, yaw, pitch, roll, canvas_mix;
};

// Must match NativeMotionKeyframe in studio_motion.rs.
struct studio_motion_key {
    uint32_t at_ms;
    struct studio_pose pose;
};

_Static_assert(sizeof(struct studio_pose) == 52, "Studio pose ABI");
_Static_assert(sizeof(struct studio_motion_key) == 56, "Studio motion key ABI");

struct studio_meshes {
    gs_vertbuffer_t *window, *backdrop, *shadow, *rim, *panel;
    CGRect content, panel_crop;
    float time, floating;
    struct studio_pose pose;
};

static void release_meshes(struct studio_meshes *meshes)
{
    gs_vertexbuffer_destroy(meshes->window);
    gs_vertexbuffer_destroy(meshes->backdrop);
    gs_vertexbuffer_destroy(meshes->shadow);
    gs_vertexbuffer_destroy(meshes->rim);
    gs_vertexbuffer_destroy(meshes->panel);
}

static void release_surface(IOSurfaceRef surface)
{
    if (surface) {
        IOSurfaceDecrementUseCount(surface);
        CFRelease(surface);
    }
}

API_AVAILABLE(macos(12.3))
@interface ProducerStudioWindowCapture : NSObject <SCStreamOutput, SCStreamDelegate> {
@public
    CGWindowID window;
    uint32_t width, height, capture_width, capture_height, fps_num, fps_den;
    _Atomic(float) room_top;
    _Atomic(float) room_bottom;
    float wider_room_top;
    float wider_room_bottom;
    CMTime widen_after;
    atomic_bool failed;
    atomic_bool drawable;
    atomic_bool canvas_only;
    // Only read or replaced in the libobs graphics context.
    gs_texture_t *texture;
    gs_texrender_t *canvas_texture;
    gs_effect_t *canvas_effect;
    gs_effect_t *capture_effect;
    bool capture_effect_attempted;
    bool canvas_effect_attempted;
    gs_vertbuffer_t *canvas_mesh;
    gs_vertbuffer_t *canvas_backdrop;
    struct studio_plane canvas_plane;
    float canvas_backdrop_floating;
    uint64_t canvas_rendered_tick;
    struct capture_frame displayed;
    struct studio_meshes meshes;
    os_unfair_lock spotlight_lock;
    bool spotlight_active;
    bool floating_active;
    struct vec4 spotlight_crop;
    // Motion commands and the video tick share this state under spotlight_lock.
    struct studio_motion_key motion_keys[studio_motion_max_keys];
    size_t motion_count, motion_index;
    uint64_t motion_started_ns, motion_return_started_ns;
    bool motion_return_pending;
    struct studio_pose motion_return_from;
    // One evaluated pose is shared by every draw of the Studio output frame.
    struct studio_pose drawn_pose;
    float spotlight_progress;
    float floating_progress;
    uint64_t last_spotlight_tick;
@private
    dispatch_queue_t queue;
    SCStream *stream;
    bool stopped;
    bool reported_frame;
    os_unfair_lock frame_lock;
    struct capture_frame latest;
}
- (void)start;
- (void)stop;
- (struct capture_frame)takeLatest;
- (struct capture_frame)takeLatestBlocking;
@end

API_AVAILABLE(macos(12.3))
static void prepare_canvas_before_program(void *data, uint32_t width, uint32_t height);

@implementation ProducerStudioWindowCapture
- (instancetype)init
{
    self = [super init];
    if (self) {
        atomic_init(&failed, false);
        atomic_init(&drawable, false);
        atomic_init(&room_top, 0.0f);
        atomic_init(&room_bottom, 1.0f);
        atomic_init(&canvas_only, false);
        frame_lock = OS_UNFAIR_LOCK_INIT;
        spotlight_lock = OS_UNFAIR_LOCK_INIT;
        drawn_pose.zoom = 1.0f;
        queue = dispatch_queue_create("dev.producer.studio-window", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)start
{
    void (^complete)(SCShareableContent *, NSError *) = ^(SCShareableContent *content, NSError *error) {
        dispatch_async(self->queue, ^{
            if (self->stopped)
                return;
            SCWindow *target = nil;
            for (SCWindow *candidate in content.windows) {
                if (candidate.windowID == self->window) {
                    target = candidate;
                    break;
                }
            }
            if (!target) {
                atomic_store(&self->failed, true);
                blog(LOG_WARNING, "[studio] window capture unavailable (%ld)", (long)error.code);
                return;
            }

            SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
            SCStreamConfiguration *config = [[SCStreamConfiguration alloc] init];
            config.width = self->capture_width;
            config.height = self->capture_height;
            config.scalesToFit = YES;
            config.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
            config.showsCursor = NO;
            config.minimumFrameInterval = CMTimeMake(self->fps_den, self->fps_num);
            config.queueDepth = 3;
            // Match libobs mac-capture's SDR Display-P3 surface and shader.
            config.pixelFormat = kCVPixelFormatType_ARGB2101010LEPacked;
            config.colorSpaceName = kCGColorSpaceDisplayP3;
            if (@available(macOS 13.0, *))
                config.capturesAudio = NO;
            if (@available(macOS 14.0, *)) {
                config.captureResolution = SCCaptureResolutionBest;
                config.preservesAspectRatio = YES;
                config.ignoreShadowsSingleWindow = YES;
                // Keep recordings focused on the Producer window when a
                // separate child is placed outside its bounds.
                config.ignoreGlobalClipSingleWindow = NO;
            }
            // A native menu from the Composer can extend above its dock.
            // Capture the room window surface without auxiliary windows.
            if (@available(macOS 14.2, *))
                config.includeChildWindows = NO;

            SCStream *candidate = [[SCStream alloc] initWithFilter:filter configuration:config delegate:self];
            NSError *output_error = nil;
            if (![candidate addStreamOutput:self type:SCStreamOutputTypeScreen
                sampleHandlerQueue:self->queue error:&output_error]) {
                atomic_store(&self->failed, true);
                blog(LOG_WARNING, "[studio] could not configure window capture (%ld)",
                     (long)output_error.code);
                return;
            }
            self->stream = candidate;
            [candidate startCaptureWithCompletionHandler:^(NSError *start_error) {
                if (start_error) {
                    dispatch_async(self->queue, ^{
                        if (self->stream == candidate && !self->stopped) {
                            atomic_store(&self->failed, true);
                            blog(LOG_WARNING, "[studio] could not start window capture (%ld)",
                                 (long)start_error.code);
                        }
                    });
                }
            }];
        });
    };
    if (@available(macOS 14.4, *)) {
        // Studio only needs this process's own Producer window, not the
        // system-wide list of screen-share targets.
        [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:complete];
    } else {
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES
            onScreenWindowsOnly:NO completionHandler:complete];
    }
}

- (void)stop
{
    dispatch_async(queue, ^{
        self->stopped = true;
        SCStream *active = self->stream;
        self->stream = nil;
        if (active) {
            [active removeStreamOutput:self type:SCStreamOutputTypeScreen error:nil];
            [active stopCaptureWithCompletionHandler:nil];
        }
        release_surface([self takeLatestBlocking].surface);
    });
}

- (void)stream:(SCStream *)sender didStopWithError:(NSError *)error
{
    dispatch_async(queue, ^{
        if (sender == self->stream && !self->stopped) {
            atomic_store(&self->failed, true);
            blog(LOG_WARNING, "[studio] window capture stopped (%ld)", (long)error.code);
        }
    });
}

- (void)stream:(SCStream *)sender didOutputSampleBuffer:(CMSampleBufferRef)sample
    ofType:(SCStreamOutputType)type
{
    if (sender != stream || type != SCStreamOutputTypeScreen || atomic_load(&failed))
        return;
    CVImageBufferRef image = CMSampleBufferGetImageBuffer(sample);
    if (!image)
        return;
    CGRect pixels = CGRectMake(0, 0, capture_width, capture_height);
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (attachments && CFArrayGetCount(attachments) > 0) {
        CFDictionaryRef info = CFArrayGetValueAtIndex(attachments, 0);
        CFNumberRef value = CFDictionaryGetValue(info, SCStreamFrameInfoStatus);
        int status = SCFrameStatusComplete;
        if (value && CFNumberGetValue(value, kCFNumberIntType, &status) &&
            status != SCFrameStatusComplete)
            return;
        CFNumberRef scale = CFDictionaryGetValue(info, SCStreamFrameInfoScaleFactor);
        CFDictionaryRef rect = CFDictionaryGetValue(info, SCStreamFrameInfoContentRect);
        CGFloat factor = 1;
        CGRect points;
        if (scale && rect && CFNumberGetValue(scale, kCFNumberCGFloatType, &factor)
            && CGRectMakeWithDictionaryRepresentation(rect, &points)) {
            CGRect content = CGRectStandardize(CGRectApplyAffineTransform(
                points, CGAffineTransformMakeScale(factor, factor)));
            content = CGRectMake(round(CGRectGetMinX(content)), round(CGRectGetMinY(content)),
                                 round(CGRectGetWidth(content)), round(CGRectGetHeight(content)));
            content = CGRectIntersection(pixels, content);
            if (!CGRectIsEmpty(content))
                pixels = content;
        }
    }
    IOSurfaceRef surface = CVPixelBufferGetIOSurface(image);
    if (!surface)
        return;
    if (!reported_frame) {
        reported_frame = true;
        blog(LOG_INFO, "[studio] window capture requested %ux%u pixels, received %zux%zu",
             capture_width, capture_height, IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface));
    }
    if (IOSurfaceGetWidth(surface) != capture_width || IOSurfaceGetHeight(surface) != capture_height) {
        atomic_store(&failed, true);
        return;
    }
    CFRetain(surface);
    IOSurfaceIncrementUseCount(surface);
    os_unfair_lock_lock(&frame_lock);
    IOSurfaceRef previous = latest.surface;
    latest = (struct capture_frame){surface, pixels, CMSampleBufferGetPresentationTimeStamp(sample)};
    os_unfair_lock_unlock(&frame_lock);
    release_surface(previous);
}

- (struct capture_frame)takeLatest
{
    if (!os_unfair_lock_trylock(&frame_lock))
        return (struct capture_frame){0};
    struct capture_frame frame = latest;
    latest = (struct capture_frame){0};
    os_unfair_lock_unlock(&frame_lock);
    return frame;
}

- (struct capture_frame)takeLatestBlocking
{
    os_unfair_lock_lock(&frame_lock);
    struct capture_frame frame = latest;
    latest = (struct capture_frame){0};
    os_unfair_lock_unlock(&frame_lock);
    return frame;
}
@end

API_AVAILABLE(macos(12.3))
static void *create_capture(obs_data_t *settings, obs_source_t *source)
{
    (void)source;
    ProducerStudioWindowCapture *capture = [[ProducerStudioWindowCapture alloc] init];
    capture->window = (CGWindowID)obs_data_get_int(settings, "window");
    atomic_store(&capture->canvas_only, obs_data_get_int(settings, "canvas_only") != 0);
    capture->width = (uint32_t)obs_data_get_int(settings, "pixel_width");
    capture->height = (uint32_t)obs_data_get_int(settings, "pixel_height");
    // A bounded 2x pixel budget keeps Retina UI and lifted close-ups sharp,
    // including after the window expands from its small launch size. Do not
    // allocate from that transient launch size and upscale it for the session.
    capture->capture_width = MIN(3840, capture->width * 2);
    capture->capture_height = MIN(2160, capture->height * 2);
    atomic_store(&capture->room_top, (float)obs_data_get_int(settings, "room_top_millionths") / 1000000.0f);
    long long room_bottom = obs_data_get_int(settings, "room_bottom_millionths");
    if (room_bottom > 0 && room_bottom < 1000000)
        atomic_store(&capture->room_bottom, (float)room_bottom / 1000000.0f);
    capture->fps_num = (uint32_t)obs_data_get_int(settings, "fps_num");
    capture->fps_den = (uint32_t)obs_data_get_int(settings, "fps_den");
    if (!capture->window || !capture->width || !capture->height || !capture->fps_num || !capture->fps_den)
        return NULL;
    void *data = (void *)CFBridgingRetain(capture);
    obs_add_main_render_callback(prepare_canvas_before_program, data);
    [capture start];
    return data;
}

API_AVAILABLE(macos(12.3))
static void destroy_capture(void *data)
{
    obs_remove_main_render_callback(prepare_canvas_before_program, data);
    ProducerStudioWindowCapture *capture = CFBridgingRelease(data);
    [capture stop];
    obs_enter_graphics();
    release_meshes(&capture->meshes);
    gs_texture_destroy(capture->texture);
    gs_texrender_destroy(capture->canvas_texture);
    gs_effect_destroy(capture->canvas_effect);
    gs_effect_destroy(capture->capture_effect);
    gs_vertexbuffer_destroy(capture->canvas_mesh);
    gs_vertexbuffer_destroy(capture->canvas_backdrop);
    release_surface(capture->displayed.surface);
    obs_leave_graphics();
}

static float studio_lerp(float from, float to, float time)
{
    return from + (to - from) * time;
}

static float studio_ease(float time)
{
    return time * time * (3.0f - 2.0f * time);
}

static struct studio_pose studio_blend_pose(struct studio_pose from, struct studio_pose to, float time)
{
    if (time <= 0.0f)
        return from;
    if (time >= 1.0f)
        return to;
    struct studio_pose pose = {
        .lift = studio_lerp(from.lift, to.lift, time),
        .floating = studio_lerp(from.floating, to.floating, time),
        .zoom = studio_lerp(from.zoom, to.zoom, time),
        .pan_x = studio_lerp(from.pan_x, to.pan_x, time),
        .pan_y = studio_lerp(from.pan_y, to.pan_y, time),
        .yaw = studio_lerp(from.yaw, to.yaw, time),
        .pitch = studio_lerp(from.pitch, to.pitch, time),
        .roll = studio_lerp(from.roll, to.roll, time),
        .canvas_mix = studio_lerp(from.canvas_mix, to.canvas_mix, time),
    };
    const float *crop = from.lift > 0.0f ? from.crop : to.crop;
    if (from.lift > 0.0f && to.lift > 0.0f && memcmp(from.crop, to.crop, sizeof(pose.crop)) != 0) {
        // Lower the first panel before raising a different one. Interpolating
        // the crop itself would sweep unrelated room controls through the close-up.
        if (time < 0.5f) {
            pose.lift = from.lift * (1.0f - studio_ease(2.0f * time));
        } else {
            crop = to.crop;
            pose.lift = to.lift * studio_ease(2.0f * time - 1.0f);
        }
    }
    memcpy(pose.crop, crop, sizeof(pose.crop));
    return pose;
}

API_AVAILABLE(macos(12.3))
static struct studio_pose studio_motion_pose(ProducerStudioWindowCapture *capture,
                                            struct studio_pose baseline, uint64_t now)
{
    if (capture->motion_count > 0) {
        if (!capture->motion_started_ns)
            capture->motion_started_ns = now;
        if (capture->motion_count == 1)
            return capture->motion_keys[0].pose;

        float elapsed = (now - capture->motion_started_ns) / 1000000.0f;
        size_t index = capture->motion_index;
        const struct studio_motion_key *keys = capture->motion_keys;
        while (index + 1 < capture->motion_count && elapsed >= keys[index + 1].at_ms)
            index++;
        capture->motion_index = index;
        if (index + 1 < capture->motion_count) {
            float time = (elapsed - keys[index].at_ms) / (keys[index + 1].at_ms - keys[index].at_ms);
            return studio_blend_pose(keys[index].pose, keys[index + 1].pose, time);
        }
        capture->motion_return_from = keys[index].pose;
        capture->motion_count = 0;
        capture->motion_return_pending = true;
    }

    if (capture->motion_return_pending) {
        capture->motion_return_pending = false;
        capture->motion_return_started_ns = now;
    }
    if (capture->motion_return_started_ns) {
        float time = (now - capture->motion_return_started_ns) / 320000000.0f;
        if (time < 1.0f)
            return studio_blend_pose(capture->motion_return_from, baseline, studio_ease(time));
        capture->motion_return_started_ns = 0;
    }
    return baseline;
}

API_AVAILABLE(macos(12.3))
static void tick_capture(void *data, float seconds)
{
    (void)seconds;
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    uint64_t now = os_gettime_ns();
    if (os_unfair_lock_trylock(&capture->spotlight_lock)) {
        if (capture->last_spotlight_tick) {
            float step = (now - capture->last_spotlight_tick) / 360000000.0f;
            float position = capture->spotlight_progress;
            capture->spotlight_progress = capture->spotlight_active
                ? fminf(1.0f, position + step) : fmaxf(0.0f, position - step);
            float floating = capture->floating_progress;
            capture->floating_progress = capture->floating_active
                ? fminf(1.0f, floating + step) : fmaxf(0.0f, floating - step);
        }
        struct vec4 crop = capture->spotlight_crop;
        struct studio_pose baseline = {
            .crop = {crop.x, crop.y, crop.z, crop.w},
            .lift = studio_ease(capture->spotlight_progress),
            .floating = studio_ease(capture->floating_progress),
            .zoom = 1.0f,
        };
        if (atomic_load(&capture->drawable) || atomic_load(&capture->canvas_only))
            capture->drawn_pose = studio_motion_pose(capture, baseline, now);
        os_unfair_lock_unlock(&capture->spotlight_lock);
    }
    capture->last_spotlight_tick = now;
    if (atomic_load(&capture->failed)) {
        // Publish readiness at the video tick so the room gate and Studio
        // source both see the same decision for this program frame.
        atomic_store(&capture->drawable, false);
        return;
    }
    struct capture_frame frame = [capture takeLatest];
    IOSurfaceRef surface = frame.surface;
    if (!surface)
        return;
    obs_enter_graphics();
    bool ready = false;
    if (capture->texture)
        ready = gs_texture_rebind_iosurface(capture->texture, (void *)surface);
    if (!ready) {
        gs_texture_t *texture = gs_texture_create_from_iosurface((void *)surface);
        if (texture) {
            gs_texture_destroy(capture->texture);
            capture->texture = texture;
            ready = true;
        }
    }
    obs_leave_graphics();
    if (ready) {
        release_surface(capture->displayed.surface);
        capture->displayed = frame;
        if (os_unfair_lock_trylock(&capture->spotlight_lock)) {
            if (CMTIME_IS_VALID(capture->widen_after) && CMTIME_IS_VALID(frame.timestamp)
                && CMTimeCompare(frame.timestamp, capture->widen_after) >= 0) {
                atomic_store(&capture->room_top, capture->wider_room_top);
                atomic_store(&capture->room_bottom, capture->wider_room_bottom);
                capture->widen_after = kCMTimeInvalid;
            }
            os_unfair_lock_unlock(&capture->spotlight_lock);
        }
        atomic_store(&capture->drawable, true);
    } else {
        release_surface(surface);
    }
}

static struct studio_projection studio_projection(struct studio_plane plane)
{
    float width = plane.width * cosf(plane.tilt);
    float height = plane.height * cosf(plane.pitch);
    float cos_roll = cosf(plane.roll);
    float sin_roll = sinf(plane.roll);
    return (struct studio_projection){
        plane.x, plane.y, width * cos_roll, -height * sin_roll,
        width * sin_roll, height * cos_roll, 0.64f * sinf(plane.tilt),
        0.44f * sinf(plane.pitch),
    };
}

static CGPoint studio_point(struct studio_projection projection, float u, float v)
{
    float depth = 1.0f + projection.depth_x * u + projection.depth_y * v;
    return CGPointMake(projection.x + (projection.xx * u + projection.xy * v) / depth,
                       projection.y + (projection.yx * u + projection.yy * v) / depth);
}

static void studio_vertex(struct studio_projection projection, float u, float v)
{
    CGPoint point = studio_point(projection, u, v);
    gs_vertex2f(point.x, point.y);
}

static void studio_fit_floating_plane(struct studio_plane *plane, float width, float height, float floating)
{
    struct studio_projection projection = studio_projection(*plane);
    CGPoint corner = studio_point(projection, -0.5f, -0.5f);
    float left = corner.x, right = corner.x, top = corner.y, bottom = corner.y;
    for (unsigned i = 1; i < 4; i++) {
        corner = studio_point(projection, (i & 1) ? 0.5f : -0.5f, (i & 2) ? 0.5f : -0.5f);
        left = fminf(left, corner.x);
        right = fmaxf(right, corner.x);
        top = fminf(top, corner.y);
        bottom = fmaxf(bottom, corner.y);
    }
    float fit = fminf(1.0f, fminf(width * (1.0f - 0.16f * floating) / (right - left),
                                  height * (1.0f - 0.14f * floating) / (bottom - top)));
    plane->width *= fit;
    plane->height *= fit;
    plane->x += (plane->x - (left + right) * 0.5f) * fit;
    plane->y += (plane->y - (top + bottom) * 0.5f) * fit;
}

static gs_vertbuffer_t *studio_plate(struct studio_plane plane, uint32_t top, uint32_t bottom)
{
    struct studio_projection projection = studio_projection(plane);
    gs_render_start(true);
    // Match the winding order of an OBS sprite.
    for (int edge = 0; edge < 2; edge++) {
        float u = edge - 0.5f;
        gs_color(bottom);
        studio_vertex(projection, u, 0.5f);
        gs_color(top);
        studio_vertex(projection, u, -0.5f);
    }
    return gs_render_save();
}

static void studio_capture_vertex(struct studio_projection projection, CGRect aperture,
                                  float sx, float sy, float x, float y)
{
    gs_texcoord((aperture.origin.x + x * aperture.size.width) * sx,
                (aperture.origin.y + y * aperture.size.height) * sy, 0);
    float u = x - 0.5f, v = y - 0.5f;
    float depth = 1.0f + projection.depth_x * u + projection.depth_y * v;
    CGPoint point = studio_point(projection, u, v);
    // Keep screen coordinates for solid shadow/dimming passes. The texture
    // vertex shader restores homogeneous W from Z, so the GPU interpolates UV
    // in perspective instead of warping text across affine triangle strips.
    gs_vertex3f(point.x, point.y, depth);
}

static gs_vertbuffer_t *studio_capture_mesh(struct studio_plane plane, CGRect aperture,
                                           float uv_scale_x, float uv_scale_y)
{
    struct studio_projection projection = studio_projection(plane);
    gs_render_start(true);
    for (unsigned edge = 0; edge < 2; edge++) {
        studio_capture_vertex(projection, aperture, uv_scale_x, uv_scale_y, edge, 1.0f);
        studio_capture_vertex(projection, aperture, uv_scale_x, uv_scale_y, edge, 0.0f);
    }
    return gs_render_save();
}

static void draw_mesh(gs_vertbuffer_t *mesh)
{
    if (mesh) {
        gs_load_vertexbuffer(mesh);
        gs_load_indexbuffer(NULL);
        gs_draw(studio_tri_strip, 0, 0);
    }
}

static uint32_t studio_tint(float progress, uint32_t r, uint32_t g, uint32_t b)
{
    return 0xFF000000u | (uint32_t)lroundf(b * progress) << 16
        | (uint32_t)lroundf(g * progress) << 8 | (uint32_t)lroundf(r * progress);
}

static uint32_t studio_backdrop_color(float x, float y, float lift, float floating)
{
    float red = studio_lerp(studio_lerp(247, 226, x), studio_lerp(216, 93, x), y);
    float green = studio_lerp(studio_lerp(101, 22, x), studio_lerp(12, 43, x), y);
    float blue = studio_lerp(studio_lerp(52, 115, x), studio_lerp(90, 231, x), y);
    return studio_tint(1.0f,
        (uint32_t)lroundf(studio_lerp(studio_lerp(19, 5, y) * lift, red, floating)),
        (uint32_t)lroundf(studio_lerp(studio_lerp(30, 10, y) * lift, green, floating)),
        (uint32_t)lroundf(studio_lerp(studio_lerp(48, 19, y) * lift, blue, floating)));
}

static gs_vertbuffer_t *studio_backdrop(float width, float height, float lift, float floating)
{
    if (floating == 0.0f) {
        struct studio_plane plane = {.x = width * 0.5f, .y = height * 0.5f,
                                     .width = width, .height = height};
        return studio_plate(plane, studio_tint(lift, 19, 30, 48), studio_tint(lift, 5, 10, 19));
    }

    gs_render_start(true);
    for (unsigned column = 0; column <= 12; column++) {
        float x = (float)column / 12;
        gs_color(studio_backdrop_color(x, 1.0f, lift, floating));
        gs_vertex2f(x * width, height);
        gs_color(studio_backdrop_color(x, 0.0f, lift, floating));
        gs_vertex2f(x * width, 0);
    }
    return gs_render_save();
}

static void studio_transform_plane(struct studio_plane *plane, const struct studio_pose *pose,
                                   float output_width, float output_height)
{
    float floating = pose->floating;
    plane->width *= 1.0f - 0.33f * floating;
    plane->height *= 1.0f - 0.33f * floating;
    plane->tilt = 0.34f * floating;
    plane->pitch = -0.60f * floating;
    plane->roll = 0.23f * floating;
    if (floating > 0.0f)
        studio_fit_floating_plane(plane, output_width, output_height, floating);
    plane->width *= pose->zoom;
    plane->height *= pose->zoom;
    plane->x += output_width * pose->pan_x;
    plane->y += output_height * pose->pan_y;
    plane->tilt += pose->yaw;
    plane->pitch += pose->pitch;
    plane->roll += pose->roll;
}

API_AVAILABLE(macos(12.3))
static void update_meshes(ProducerStudioWindowCapture *capture, bool use_rect)
{
    CGRect window = capture->displayed.content_pixels;
    CGRect content = window;
    float room_top = atomic_load(&capture->room_top);
    float room_bottom = atomic_load(&capture->room_bottom);
    if (room_top > 0.0f || room_bottom < 1.0f) {
        // Stay one source pixel clear of the editor at the sampling boundary.
        content.origin.y += ceil(window.size.height * room_top);
        content.size.height = fmax(1.0, floor(window.size.height * (room_bottom - room_top)) - 1.0);
    }
    struct studio_pose pose = capture->drawn_pose;
    CGRect panel = CGRectIntersection(content, CGRectMake(
        window.origin.x + pose.crop[0] * window.size.width,
        window.origin.y + pose.crop[1] * window.size.height,
        pose.crop[2] * window.size.width, pose.crop[3] * window.size.height));
    float time = CGRectIsEmpty(panel) ? 0.0f : pose.lift;
    float floating = pose.floating;
    struct studio_meshes *meshes = &capture->meshes;
    if (meshes->window && memcmp(&meshes->pose, &pose, sizeof(pose)) == 0
        && CGRectEqualToRect(meshes->content, content))
        return;

    // Metal executes these draws after CPU submission. Independent mesh
    // buffers prevent a later layer from overwriting the earlier draw's
    // vertices. Reuse the complete pose between animation and resize ticks.
    release_meshes(meshes);
    *meshes = (struct studio_meshes){.content = content, .panel_crop = panel,
                                    .time = time, .floating = floating, .pose = pose};

    float width = capture->width, height = capture->height;
    float sx = use_rect ? 1.0f : 1.0f / capture->capture_width;
    float sy = use_rect ? 1.0f : 1.0f / capture->capture_height;
    float fit = fminf(width / content.size.width, height / content.size.height);
    struct studio_plane window_plane = {
        width * 0.5f, height * 0.5f, floorf(content.size.width * fit),
        floorf(content.size.height * fit), 0.0f, 0.0f, 0.0f,
    };
    bool letterboxed = window_plane.width < width || window_plane.height < height;
    studio_transform_plane(&window_plane, &pose, width, height);

    if (time > 0.0f) {
        const float crop[] = {
            (panel.origin.x - content.origin.x) / content.size.width,
            (panel.origin.y - content.origin.y) / content.size.height,
            panel.size.width / content.size.width,
            panel.size.height / content.size.height,
        };
        float direction = crop[0] + crop[2] * 0.5f >= 0.5f ? 1.0f : -1.0f;
        float scale = fminf(1.5f, fminf(0.46f * width / panel.size.width,
                                        0.90f * height / panel.size.height));
        struct studio_projection projection = studio_projection(window_plane);
        float u = crop[0] + crop[2] * 0.5f - 0.5f;
        float v = crop[1] + crop[3] * 0.5f - 0.5f;
        float depth = 1.0f + projection.depth_x * u + projection.depth_y * v;
        CGPoint anchor = studio_point(projection, u, v);
        float start_width = window_plane.width * crop[2] / depth;
        float start_height = window_plane.height * crop[3] / depth;
        struct studio_plane panel_plane = {
            studio_lerp(anchor.x, width * (0.5f + 0.245f * direction), time),
            studio_lerp(anchor.y, height * 0.51f, time),
            studio_lerp(start_width, panel.size.width * scale, time),
            studio_lerp(start_height, panel.size.height * scale, time),
            studio_lerp(window_plane.tilt * crop[2], -0.075f * direction, time),
            window_plane.pitch * (1.0f - time), window_plane.roll * (1.0f - time),
        };
        window_plane.x -= width * 0.09f * direction * time;
        window_plane.y -= height * 0.02f * time;
        window_plane.width *= 1.0f - studio_lerp(0.26f, 0.15f, floating) * time;
        window_plane.height *= 1.0f - studio_lerp(0.26f, 0.15f, floating) * time;
        window_plane.tilt += studio_lerp(0.32f, 0.10f, floating) * direction * time;
        struct studio_plane rim = panel_plane;
        rim.width += 4.0f * time;
        rim.height += 4.0f * time;
        struct studio_plane shadow = rim;
        shadow.y += 9.0f * time;
        shadow.width += 14.0f * time;
        shadow.height += 14.0f * time;
        uint32_t shade = (uint32_t)lroundf(0.22f * time * 255.0f) << 24;
        meshes->shadow = studio_plate(shadow, shade, shade);
        meshes->rim = studio_plate(rim, studio_tint(time, 66, 104, 123),
                                   studio_tint(time, 26, 52, 70));
        meshes->panel = studio_capture_mesh(panel_plane, panel, sx, sy);
    }

    meshes->window = studio_capture_mesh(window_plane, content, sx, sy);
    if (floating > 0.0f || time > 0.0f || pose.zoom < 1.0f || pose.pan_x != 0.0f || pose.pan_y != 0.0f
        || pose.yaw != 0.0f || pose.pitch != 0.0f || pose.roll != 0.0f
        || letterboxed)
        meshes->backdrop = studio_backdrop(width, height, time, floating);
}

// Retain the engine's color management, backend syntax and sampling behavior.
// Only restore homogeneous W so the rasterizer interpolates texture coordinates
// exactly in perspective; an entire plane now needs four vertices.
extern char *obs_find_data_file(const char *);
static gs_effect_t *studio_capture_effect(bool rect)
{
    char *path = obs_find_data_file(rect ? "default_rect.effect" : "default.effect");
    if (!path) return NULL;
    NSString *shader = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:path]
                                               encoding:NSUTF8StringEncoding error:nil];
    shader = [shader stringByReplacingOccurrencesOfString:@"float4(vert_in.pos.xyz, 1.0)"
                                               withString:@"float4(vert_in.pos.xy * vert_in.pos.z, 0.0, vert_in.pos.z)"];
    char *error = NULL;
    gs_effect_t *effect = shader ? gs_effect_create(shader.UTF8String, path, &error) : NULL;
    if (error) { blog(LOG_WARNING,"[studio] projective compositor: %s",error);bfree(error); }
    bfree(path);
    return effect;
}
static const char *studio_canvas_effect =
    "uniform float4x4 ViewProj;uniform texture2d image;uniform float opacity;uniform float2 extent;uniform float radius;"
    "sampler_state smp{Filter=Linear;AddressU=Clamp;AddressV=Clamp;};"
    "struct V{float4 pos:POSITION;float2 uv:TEXCOORD0;};"
    "V VS(V v){V o;o.pos=mul(float4(v.pos.xy*v.pos.z,0.0,v.pos.z),ViewProj);o.uv=v.uv;return o;}"
    "float4 PS(V v):TARGET{float4 rgba=image.Sample(smp,v.uv);"
    "float2 halfSize=extent*0.5;float2 q=abs((v.uv-0.5)*extent)-(halfSize-radius);"
    "float d=length(max(q,float2(0,0)))+min(max(q.x,q.y),0.0)-radius;"
    "float mask=1.0-smoothstep(-0.75,0.75,d);return rgba*(opacity*mask);}"
    "technique Draw{pass{vertex_shader=VS(v);pixel_shader=PS(v);}}";

API_AVAILABLE(macos(12.3))
static void prepare_canvas_before_program(void *data, uint32_t width, uint32_t height)
{
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    if (!atomic_load(&capture->canvas_only) && capture->drawn_pose.canvas_mix <= 0.0f)
        return;
    // The callback also runs for auxiliary mixes. Capture just the main
    // canvas before its channel loop acquires the output source mutex.
    if (width != capture->width || height != capture->height || gs_get_render_target() != obs_get_main_texture())
        return;
    if (!capture->canvas_texture)
        capture->canvas_texture = gs_texrender_create(GS_RGBA, GS_ZS_NONE);
    if (!capture->canvas_effect_attempted) {
        capture->canvas_effect_attempted = true;
        char *error = NULL;
        capture->canvas_effect = gs_effect_create(studio_canvas_effect, "producer-studio-canvas.effect", &error);
        if (error) {
            blog(LOG_WARNING, "[studio] canvas compositor: %s", error);
            bfree(error);
        }
    }
    if (!capture->canvas_texture)
        return;

    obs_source_t *room = obs_get_output_source(0);
    if (!room)
        return;
    gs_texrender_reset(capture->canvas_texture);
    bool ready = gs_texrender_begin_with_color_space(capture->canvas_texture, width, height, GS_CS_SRGB);
    if (ready) {
        bool linear = gs_get_linear_srgb();
        bool srgb = gs_framebuffer_srgb_enabled();
        gs_blend_state_push();
        gs_matrix_push();
        gs_matrix_identity();
        gs_set_linear_srgb(false);
        gs_enable_framebuffer_srgb(false);
        const struct vec4 transparent = {0, 0, 0, 0};
        gs_clear(GS_CLEAR_COLOR, &transparent, 0, 0);
        gs_ortho(0, width, 0, height, -100, 100);
        // This surface differs from the main render target. The Studio room
        // gate therefore permits the original room video to render here.
        obs_source_video_render(room);
        gs_matrix_pop();
        gs_blend_state_pop();
        gs_texrender_end(capture->canvas_texture);
        gs_set_linear_srgb(linear);
        gs_enable_framebuffer_srgb(srgb);
        capture->canvas_rendered_tick = capture->last_spotlight_tick;
    }
    obs_source_release(room);
}

API_AVAILABLE(macos(12.3))
static void render_canvas(ProducerStudioWindowCapture *capture, gs_effect_t *solid,
                          float opacity, bool has_window, bool ready, float width, float height)
{
    struct studio_pose pose = capture->drawn_pose;
    struct studio_plane plane = {
        .x = width * 0.5f, .y = height * 0.5f,
        .width = width, .height = height,
    };
    studio_transform_plane(&plane, &pose, width, height);
    bool needs_backdrop = !has_window && (!ready || pose.floating > 0.0f || pose.zoom != 1.0f
        || pose.pan_x != 0.0f || pose.pan_y != 0.0f || pose.yaw != 0.0f || pose.pitch != 0.0f
        || pose.roll != 0.0f);
    if (needs_backdrop) {
        if (!capture->canvas_backdrop || capture->canvas_backdrop_floating != pose.floating) {
            gs_vertexbuffer_destroy(capture->canvas_backdrop);
            capture->canvas_backdrop = studio_backdrop(width, height, 0.0f, pose.floating);
            capture->canvas_backdrop_floating = pose.floating;
        }
        gs_enable_framebuffer_srgb(false);
        const struct vec4 white = {1, 1, 1, 1};
        gs_effect_set_vec4(gs_effect_get_param_by_name(solid, "color"), &white);
        while (gs_effect_loop(solid, "SolidColored"))
            draw_mesh(capture->canvas_backdrop);
    }
    if (!ready)
        return;
    if (!capture->canvas_mesh || memcmp(&plane, &capture->canvas_plane, sizeof(plane)) != 0) {
        gs_vertexbuffer_destroy(capture->canvas_mesh);
        capture->canvas_mesh = studio_capture_mesh(plane, CGRectMake(0, 0, 1, 1), 1, 1);
        capture->canvas_plane = plane;
    }
    bool blend = capture->canvas_effect != NULL;
    gs_effect_t *effect = blend ? capture->canvas_effect : obs_get_base_effect(OBS_EFFECT_DEFAULT);
    if (!effect)
        return;
    bool linear = gs_get_linear_srgb();
    gs_enable_framebuffer_srgb(linear);
    gs_eparam_t *image = gs_effect_get_param_by_name(effect, "image");
    gs_texture_t *texture = gs_texrender_get_texture(capture->canvas_texture);
    if (linear)
        gs_effect_set_texture_srgb(image, texture);
    else
        gs_effect_set_texture(image, texture);
    if (blend) {
        const struct vec2 extent = {width, height};
        gs_effect_set_float(gs_effect_get_param_by_name(effect, "opacity"), opacity);
        gs_effect_set_vec2(gs_effect_get_param_by_name(effect, "extent"), &extent);
        gs_effect_set_float(gs_effect_get_param_by_name(effect, "radius"), fminf(width, height) * (48.0f / 1080.0f));
    }
    while (gs_effect_loop(effect, "Draw"))
        draw_mesh(capture->canvas_mesh);
}

API_AVAILABLE(macos(12.3))
static void render_capture(void *data, gs_effect_t *unused_effect)
{
    (void)unused_effect;
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    bool canvas_only = atomic_load(&capture->canvas_only);
    float canvas_mix = canvas_only ? 1.0f : capture->drawn_pose.canvas_mix;
    bool has_window = canvas_mix < 1.0f && atomic_load(&capture->drawable);
    if (!has_window && canvas_mix == 0.0f)
        return;

    bool canvas_ready = capture->canvas_rendered_tick != 0
        && capture->canvas_rendered_tick == capture->last_spotlight_tick;
    bool use_rect = gs_get_device_type() == GS_DEVICE_OPENGL;
    if (!capture->capture_effect_attempted) {
        capture->capture_effect_attempted = true;
        capture->capture_effect = studio_capture_effect(use_rect);
    }
    gs_effect_t *image = capture->capture_effect;
    gs_effect_t *solid = obs_get_base_effect(studio_solid_effect);
    if (!solid)
        return;
    bool srgb = gs_framebuffer_srgb_enabled();
    gs_blend_state_push();
    gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);

    if (!has_window || !image) {
        if (canvas_mix > 0.0f)
            render_canvas(capture, solid, 1.0f, false, canvas_ready, capture->width, capture->height);
        gs_enable_framebuffer_srgb(srgb);
        gs_blend_state_pop();
        return;
    }

    update_meshes(capture, use_rect);
    const struct studio_meshes *meshes = &capture->meshes;
    gs_eparam_t *color = gs_effect_get_param_by_name(solid, "color");
    const struct vec4 white = {1, 1, 1, 1};
    gs_effect_set_vec4(color, &white);
    if (meshes->backdrop) {
        gs_enable_framebuffer_srgb(false);
        while (gs_effect_loop(solid, "SolidColored"))
            draw_mesh(meshes->backdrop);
    }

    gs_eparam_t *texture = gs_effect_get_param_by_name(image, "image");
    gs_enable_framebuffer_srgb(true);
    gs_effect_set_texture(texture, capture->texture);
    while (gs_effect_loop(image, "DrawD65P3"))
        draw_mesh(meshes->window);

    if (meshes->panel) {
        gs_enable_framebuffer_srgb(false);
        const struct vec4 dim = {0, 0, 0, 0.30f * meshes->time};
        gs_effect_set_vec4(color, &dim);
        while (gs_effect_loop(solid, "Solid"))
            draw_mesh(meshes->window);
        gs_effect_set_vec4(color, &white);
        while (gs_effect_loop(solid, "SolidColored")) {
            draw_mesh(meshes->shadow);
            draw_mesh(meshes->rim);
        }
        gs_enable_framebuffer_srgb(true);
        gs_effect_set_texture(texture, capture->texture);
        while (gs_effect_loop(image, "DrawD65P3"))
            draw_mesh(meshes->panel);
    }
    if (canvas_ready)
        render_canvas(capture, solid, canvas_mix, true, true, capture->width, capture->height);
    gs_enable_framebuffer_srgb(srgb);
    gs_blend_state_pop();
}

API_AVAILABLE(macos(12.3))
static uint32_t capture_width(void *data)
{
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    return atomic_load(&capture->canvas_only) || atomic_load(&capture->drawable) ? capture->width : 0;
}

API_AVAILABLE(macos(12.3))
static uint32_t capture_height(void *data)
{
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    return atomic_load(&capture->canvas_only) || atomic_load(&capture->drawable) ? capture->height : 0;
}

bool producer_studio_window_capture_failed(obs_source_t *source)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        return !capture || (!atomic_load(&capture->canvas_only) && atomic_load(&capture->failed));
    }
    return true;
}

bool producer_studio_window_set_canvas_only(obs_source_t *source, bool enabled)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        if (!capture || (!enabled && atomic_load(&capture->failed)))
            return false;
        atomic_store(&capture->canvas_only, enabled);
        return true;
    }
    return false;
}

bool producer_studio_window_set_room_crop(obs_source_t *source, float top, float bottom)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        if (!capture || atomic_load(&capture->failed) || !isfinite(top) || !isfinite(bottom) || top < 0.0f || top >= bottom || bottom > 1.0f)
            return false;
        os_unfair_lock_lock(&capture->spotlight_lock);
        if (top >= atomic_load(&capture->room_top) && bottom <= atomic_load(&capture->room_bottom)) {
            atomic_store(&capture->room_top, top);
            atomic_store(&capture->room_bottom, bottom);
            capture->widen_after = kCMTimeInvalid;
        } else {
            // Moving the authoring row can tighten one edge while widening
            // the other. Hide the newly occupied edge immediately; only the
            // expansion waits for a fresh frame without the old editor.
            atomic_store(&capture->room_top, fmaxf(top, atomic_load(&capture->room_top)));
            atomic_store(&capture->room_bottom, fminf(bottom, atomic_load(&capture->room_bottom)));
            // The cached surface can still contain the editor just unmounted.
            // Widen only on a complete sample produced after the UI settled.
            capture->wider_room_top = top;
            capture->wider_room_bottom = bottom;
            capture->widen_after = CMTimeAdd(CMClockGetTime(CMClockGetHostTimeClock()),
                                            CMTimeMake(150, 1000));
        }
        os_unfair_lock_unlock(&capture->spotlight_lock);
        return true;
    }
    return false;
}

bool producer_studio_window_set_spotlight(obs_source_t *source, bool active,
                                         float x, float y, float w, float h)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        if (!capture || atomic_load(&capture->failed))
            return false;
        if (active && (!isfinite(x) || !isfinite(y) || !isfinite(w) || !isfinite(h) ||
                       x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.00001f || y + h > 1.00001f))
            return false;
        os_unfair_lock_lock(&capture->spotlight_lock);
        if (active)
            capture->spotlight_crop = (struct vec4){x, y, w, h};
        capture->spotlight_active = active;
        os_unfair_lock_unlock(&capture->spotlight_lock);
        return true;
    }
    return false;
}

bool producer_studio_window_set_floating(obs_source_t *source, bool active)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        if (!capture || atomic_load(&capture->failed))
            return false;
        os_unfair_lock_lock(&capture->spotlight_lock);
        capture->floating_active = active;
        os_unfair_lock_unlock(&capture->spotlight_lock);
        return true;
    }
    return false;
}

bool producer_studio_window_set_motion(obs_source_t *source, const struct studio_motion_key *keys, size_t count)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        if (!capture || count > studio_motion_max_keys
            || (atomic_load(&capture->failed) && !atomic_load(&capture->canvas_only)))
            return false;
        os_unfair_lock_lock(&capture->spotlight_lock);
        if (count > 0) {
            memcpy(capture->motion_keys, keys, count * sizeof(*keys));
            capture->motion_return_started_ns = 0;
            capture->motion_return_pending = false;
        } else if (capture->motion_count > 0 && capture->motion_started_ns) {
            capture->motion_return_from = capture->drawn_pose;
            capture->motion_return_pending = true;
        }
        capture->motion_count = count;
        capture->motion_index = 0;
        capture->motion_started_ns = 0;
        os_unfair_lock_unlock(&capture->spotlight_lock);
        return true;
    }
    return false;
}

static const char *capture_name(void *unused)
{
    (void)unused;
    return "Producer Studio Window";
}

bool producer_studio_window_capture_available(void)
{
    if (@available(macOS 12.3, *))
        return true;
    return false;
}

void producer_studio_window_capture_register(void)
{
    if (@available(macOS 12.3, *)) {
        const struct obs_source_info info = {
            .id = "producer_studio_window",
            .type = OBS_SOURCE_TYPE_INPUT,
            .output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB,
            .get_name = capture_name,
            .create = create_capture,
            .destroy = destroy_capture,
            .get_width = capture_width,
            .get_height = capture_height,
            .video_tick = tick_capture,
            .video_render = render_capture,
        };
        obs_register_source_s(&info, sizeof(info));
    }
}
