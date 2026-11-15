// Studio captures its own window at the program canvas's pixel size.
// ScreenCaptureKit fits the whole window directly into that surface, so OBS
// can draw it at 1:1 even as the window moves or resizes on a Retina display.
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <os/lock.h>

#include <math.h>
#include <stdatomic.h>
#include "obs_min.h"

extern long long obs_data_get_int(obs_data_t *, const char *);
extern bool gs_texture_rebind_iosurface(gs_texture_t *, void *);
extern bool gs_effect_loop(gs_effect_t *, const char *);

struct capture_frame {
    IOSurfaceRef surface;
    CGRect content_pixels;
};

// Same Display-P3 conversion as the libobs ScreenCaptureKit effect. This
// variant moves the window's 1:1 pixels to center the aspect ratio bands.
static const char *centered_effect_prefix =
    "uniform float4x4 ViewProj; uniform float4 aperture; uniform float2 offset;\n";
static const char *centered_effect_body =
    "sampler_state pixel_sampler { Filter=Point; AddressU=Clamp; AddressV=Clamp; };\n"
    "struct Vertex { float4 pos:POSITION; float2 uv:TEXCOORD0; };\n"
    "Vertex VS(Vertex v) { v.pos=mul(float4(v.pos.xyz,1.0),ViewProj); return v; }\n"
    "float linear_channel(float v) { return v<=0.04045 ? v/12.92 : pow((v+0.055)/1.055,2.4); }\n"
    "float4 PS(Vertex v):TARGET {\n"
    " float2 uv=v.uv-offset;\n"
    " if (uv.x<aperture.x || uv.y<aperture.y || uv.x>=aperture.z || uv.y>=aperture.w)"
    "  return float4(0,0,0,1);\n"
    " float4 rgba=image.Sample(pixel_sampler,uv);\n"
    " float3 c=float3(linear_channel(rgba.r),linear_channel(rgba.g),linear_channel(rgba.b));\n"
    " return float4(dot(c,float3(1.2249402,-0.2249402,0)),"
    " dot(c,float3(-0.0420570,1.0420570,0)),"
    " dot(c,float3(-0.0196376,-0.0786360,1.0982736)),rgba.a);\n"
    "}\n"
    "technique Draw { pass { vertex_shader=VS(v); pixel_shader=PS(v); } }\n";

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
    uint32_t width, height, fps_num, fps_den;
    atomic_bool failed;
    atomic_bool drawable;
    // Only read or replaced in the libobs graphics context.
    gs_texture_t *texture;
    struct capture_frame displayed;
    gs_effect_t *centered_effect;
    bool tried_centering;
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

@implementation ProducerStudioWindowCapture
- (instancetype)init
{
    self = [super init];
    if (self) {
        atomic_init(&failed, false);
        atomic_init(&drawable, false);
        frame_lock = OS_UNFAIR_LOCK_INIT;
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
            config.width = self->width;
            config.height = self->height;
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
            if (@available(macOS 14.2, *))
                config.includeChildWindows = YES;

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
    CGRect pixels = CGRectMake(0, 0, width, height);
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
             width, height, IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface));
    }
    if (IOSurfaceGetWidth(surface) != width || IOSurfaceGetHeight(surface) != height) {
        atomic_store(&failed, true);
        return;
    }
    CFRetain(surface);
    IOSurfaceIncrementUseCount(surface);
    os_unfair_lock_lock(&frame_lock);
    IOSurfaceRef previous = latest.surface;
    latest = (struct capture_frame){surface, pixels};
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
    capture->width = (uint32_t)obs_data_get_int(settings, "pixel_width");
    capture->height = (uint32_t)obs_data_get_int(settings, "pixel_height");
    capture->fps_num = (uint32_t)obs_data_get_int(settings, "fps_num");
    capture->fps_den = (uint32_t)obs_data_get_int(settings, "fps_den");
    if (!capture->window || !capture->width || !capture->height || !capture->fps_num || !capture->fps_den)
        return NULL;
    [capture start];
    return (void *)CFBridgingRetain(capture);
}

API_AVAILABLE(macos(12.3))
static void destroy_capture(void *data)
{
    ProducerStudioWindowCapture *capture = CFBridgingRelease(data);
    [capture stop];
    obs_enter_graphics();
    if (capture->centered_effect)
        gs_effect_destroy(capture->centered_effect);
    gs_texture_destroy(capture->texture);
    release_surface(capture->displayed.surface);
    obs_leave_graphics();
}

API_AVAILABLE(macos(12.3))
static void tick_capture(void *data, float seconds)
{
    (void)seconds;
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
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
        atomic_store(&capture->drawable, true);
    } else {
        release_surface(surface);
    }
}

API_AVAILABLE(macos(12.3))
static void render_capture(void *data, gs_effect_t *unused_effect)
{
    (void)unused_effect;
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    if (!atomic_load(&capture->drawable))
        return;
    bool use_rect = gs_get_device_type() == GS_DEVICE_OPENGL;
    // OBS_EFFECT_DEFAULT_RECT = 1 (libobs/obs.h), for OpenGL IOSurface textures.
    gs_effect_t *effect = obs_get_base_effect(use_rect ? 1 : OBS_EFFECT_DEFAULT);
    const char *technique = "DrawD65P3";
    CGRect content = capture->displayed.content_pixels;
    if (content.size.width != capture->width || content.size.height != capture->height) {
        if (!capture->tried_centering) {
            capture->tried_centering = true;
            const char *texture_type = use_rect ? "texture_rect" : "texture2d";
            NSString *shader = [NSString stringWithFormat:@"%suniform %s image;\n%s",
                centered_effect_prefix, texture_type, centered_effect_body];
            capture->centered_effect = gs_effect_create(shader.UTF8String, "studio-center.effect", NULL);
        }
        if (capture->centered_effect) {
            effect = capture->centered_effect;
            technique = "Draw";
            CGFloat x_scale = use_rect ? 1 : 1.0 / capture->width;
            CGFloat y_scale = use_rect ? 1 : 1.0 / capture->height;
            struct vec4 aperture = {
                CGRectGetMinX(content) * x_scale, CGRectGetMinY(content) * y_scale,
                CGRectGetMaxX(content) * x_scale, CGRectGetMaxY(content) * y_scale,
            };
            struct vec2 offset = {
                (floor((capture->width - content.size.width) / 2) - content.origin.x) * x_scale,
                (floor((capture->height - content.size.height) / 2) - content.origin.y) * y_scale,
            };
            gs_effect_set_vec4(gs_effect_get_param_by_name(effect, "aperture"), &aperture);
            gs_effect_set_vec2(gs_effect_get_param_by_name(effect, "offset"), &offset);
        }
    }
    if (!effect)
        return;
    bool srgb = gs_framebuffer_srgb_enabled();
    gs_enable_framebuffer_srgb(true);
    gs_effect_set_texture(gs_effect_get_param_by_name(effect, "image"), capture->texture);
    while (gs_effect_loop(effect, technique))
        gs_draw_sprite(capture->texture, 0, 0, 0);
    gs_enable_framebuffer_srgb(srgb);
}

API_AVAILABLE(macos(12.3))
static uint32_t capture_width(void *data)
{
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    return atomic_load(&capture->drawable) ? capture->width : 0;
}

API_AVAILABLE(macos(12.3))
static uint32_t capture_height(void *data)
{
    ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)data;
    return atomic_load(&capture->drawable) ? capture->height : 0;
}

bool producer_studio_window_capture_failed(obs_source_t *source)
{
    if (@available(macOS 12.3, *)) {
        ProducerStudioWindowCapture *capture = (__bridge ProducerStudioWindowCapture *)obs_obj_get_data(source);
        return !capture || atomic_load(&capture->failed);
    }
    return true;
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
