// Producer Live — Cutout: a person mask from Apple's Vision framework applied
// as a libobs video filter, so any camera or guest tile gets a cutout.
//
// Two halves, one file:
//
//   ProducerSegmentation   the MASK PROVIDER. Takes the source frame (a Metal
//                          texture on the Metal backend, BGRA bytes on the
//                          OpenGL fallback), runs
//                          VNGeneratePersonSegmentationRequest on its own
//                          serial queue, and publishes the newest mask as an
//                          IOSurface-backed pixel buffer plus a sequence
//                          number. A frame arriving while one is in flight is
//                          dropped: the filter always samples the most recent
//                          COMPLETED mask (one or two frames of latency).
//
//   producer_person_mask   the libobs FILTER. On video_render it renders its
//                          target to a texture, feeds a downscaled copy to the
//                          provider, binds the latest mask as a gs_texture
//                          created straight from the IOSurface (no upload),
//                          and composites with person_mask.effect.h.
//
// The graphics-thread rule (LIVE-REVIEW.md §5.1 + the A10 finding): nothing
// here blocks the OBS graphics thread on the GPU or on Vision.
//   * Metal: gs_texture_get_obj() hands out the id<MTLTexture>; the copy into
//     Vision's pixel buffer is a blit on the provider's OWN command queue,
//     waited on the provider thread. libobs-metal's gs_stage_texture and
//     gs_copy_texture both waitUntilCompleted on the graphics thread, which
//     is exactly why they are not used on this backend. The texture handed
//     over is the ring entry rendered two renders EARLIER (4-deep ring), so
//     libobs has committed the commands that drew it.
//   * OpenGL (Intel Macs): the readback ring the encoder pipeline uses —
//     gs_stage_texture this frame, gs_stagesurface_map the surface staged
//     LAST frame — so the map does not stall on an in-flight download.
//   * The mask never crosses back through a gs_texture upload: Vision's
//     result is copied into an IOSurface on the provider thread and the
//     graphics thread binds it with gs_texture_create_from_iosurface (both
//     backends support that; it is the Syphon path).
//
// Registered from the shim (producer_person_mask_register in shim.m), which
// is why libobs is reached through obs_min.h rather than obs-module.h.

#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>
#import <Vision/Vision.h>

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#include "obs_min.h"
#include "person_mask.effect.h"

// Longest edge fed to Vision. .balanced runs its network at a fixed internal
// size anyway; feeding it more only costs the blit.
#define PM_ANALYSIS_MAX_W 768
// Sources taller than this get .fast: the blit and the network both scale.
#define PM_FAST_ABOVE_H 1080
#define PM_ANA_RING 4
#define PM_MASK_RING 3
#define PM_RETIRED_MAX 8
// `erode` (0–1) in mask texels at 1.0.
#define PM_ERODE_TEXELS 8.0f
// `blur` (0–1) in half-res texels per tap at 1.0.
#define PM_BLUR_TEXELS 10.0f

enum pm_mode { PM_OFF = 0, PM_SOFT = 1, PM_CUT = 2 };

// ── Mask provider ────────────────────────────────────────────────────────────

@interface ProducerSegmentation : NSObject {
@public
	dispatch_queue_t _queue;
	atomic_bool _busy;
	// Index of the newest completed mask, -1 until the first one lands.
	atomic_int _front;
	atomic_uint_fast64_t _seq;
	CVPixelBufferRef _masks[PM_MASK_RING];
	// Slots replaced after a size change park here until dealloc: the
	// graphics thread may still be sampling them for a frame.
	CVPixelBufferRef _retired[PM_RETIRED_MAX];
	int _retired_n;
	// The one input buffer; `_busy` is what makes one enough.
	CVPixelBufferRef _frame;
	int _frame_w, _frame_h;
	CVMetalTextureCacheRef _texCache;
	id<MTLDevice> _device;
	id<MTLCommandQueue> _cmdq;
	// VNGeneratePersonSegmentationRequest; typed id so the class compiles
	// below macOS 12 (the deployment floor is 11). Touched only under
	// @available.
	id _request;
	// OpenGL cannot bind a one-component IOSurface; it gets BGRA with the
	// mask replicated into every channel.
	OSType _maskFormat;
	int _mask_w, _mask_h;
}
@end

@implementation ProducerSegmentation

- (instancetype)initWithBGRAMask:(BOOL)bgra {
	if (@available(macOS 12.0, *)) {
		self = [super init];
		if (!self)
			return nil;
		_queue = dispatch_queue_create("ai.boomin.producer.segmentation", DISPATCH_QUEUE_SERIAL);
		atomic_init(&_busy, false);
		atomic_init(&_front, -1);
		atomic_init(&_seq, 0);
		_maskFormat = bgra ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_OneComponent8;
		VNGeneratePersonSegmentationRequest *req = [[VNGeneratePersonSegmentationRequest alloc] init];
		req.qualityLevel = VNGeneratePersonSegmentationRequestQualityLevelBalanced;
		req.outputPixelFormat = kCVPixelFormatType_OneComponent8;
		NSIndexSet *revs = [VNGeneratePersonSegmentationRequest supportedRevisions];
		if (revs.count > 0)
			req.revision = revs.lastIndex;
		_request = req;
		return self;
	}
	return nil;
}

- (void)dealloc {
	for (int i = 0; i < PM_MASK_RING; i++)
		if (_masks[i])
			CVPixelBufferRelease(_masks[i]);
	for (int i = 0; i < _retired_n; i++)
		CVPixelBufferRelease(_retired[i]);
	if (_frame)
		CVPixelBufferRelease(_frame);
	if (_texCache)
		CFRelease(_texCache);
}

// Provider queue only.
- (BOOL)ensureFrame:(int)w height:(int)h {
	if (_frame && _frame_w == w && _frame_h == h)
		return YES;
	if (_frame)
		CVPixelBufferRelease(_frame);
	_frame = NULL;
	NSDictionary *attrs = @{
		(id)kCVPixelBufferIOSurfacePropertiesKey : @{},
		(id)kCVPixelBufferMetalCompatibilityKey : @YES,
	};
	CVReturn rc = CVPixelBufferCreate(kCFAllocatorDefault, (size_t)w, (size_t)h, kCVPixelFormatType_32BGRA,
					  (__bridge CFDictionaryRef)attrs, &_frame);
	if (rc != kCVReturnSuccess) {
		blog(LOG_WARNING, "[person_mask] frame buffer %dx%d failed (%d)", w, h, (int)rc);
		_frame = NULL;
		return NO;
	}
	_frame_w = w;
	_frame_h = h;
	return YES;
}

// Provider queue only. Returns the slot to write, sized for the mask.
- (int)prepareSlot:(int)w height:(int)h {
	int front = atomic_load(&_front);
	int slot = front < 0 ? 0 : (front + 1) % PM_MASK_RING;
	CVPixelBufferRef pb = _masks[slot];
	if (pb && (int)CVPixelBufferGetWidth(pb) == w && (int)CVPixelBufferGetHeight(pb) == h)
		return slot;
	if (pb) {
		if (_retired_n < PM_RETIRED_MAX)
			_retired[_retired_n++] = pb;
		else
			CVPixelBufferRelease(pb); // ring has cycled many times since
		_masks[slot] = NULL;
	}
	NSDictionary *attrs = @{(id)kCVPixelBufferIOSurfacePropertiesKey : @{}};
	CVReturn rc = CVPixelBufferCreate(kCFAllocatorDefault, (size_t)w, (size_t)h, _maskFormat,
					  (__bridge CFDictionaryRef)attrs, &_masks[slot]);
	if (rc != kCVReturnSuccess) {
		blog(LOG_WARNING, "[person_mask] mask buffer %dx%d failed (%d)", w, h, (int)rc);
		_masks[slot] = NULL;
		return -1;
	}
	return slot;
}

// Provider queue only: run Vision over _frame and publish the mask.
- (void)segmentFast:(BOOL)fast {
	if (@available(macOS 12.0, *)) {
		if (!_frame)
			return;
		VNGeneratePersonSegmentationRequest *req = (VNGeneratePersonSegmentationRequest *)_request;
		req.qualityLevel = fast ? VNGeneratePersonSegmentationRequestQualityLevelFast
					: VNGeneratePersonSegmentationRequestQualityLevelBalanced;
		VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCVPixelBuffer:_frame options:@{}];
		NSError *err = nil;
		if (![handler performRequests:@[ req ] error:&err]) {
			static int logged = 0;
			if (logged++ < 3)
				blog(LOG_WARNING, "[person_mask] segmentation failed: %s",
				     err.localizedDescription.UTF8String ?: "?");
			return;
		}
		VNPixelBufferObservation *obs = req.results.firstObject;
		CVPixelBufferRef src = obs.pixelBuffer;
		if (!src)
			return;
		int w = (int)CVPixelBufferGetWidth(src), h = (int)CVPixelBufferGetHeight(src);
		int slot = [self prepareSlot:w height:h];
		if (slot < 0)
			return;
		CVPixelBufferRef dst = _masks[slot];
		CVPixelBufferLockBaseAddress(src, kCVPixelBufferLock_ReadOnly);
		CVPixelBufferLockBaseAddress(dst, 0);
		const uint8_t *sp = CVPixelBufferGetBaseAddress(src);
		uint8_t *dp = CVPixelBufferGetBaseAddress(dst);
		size_t sls = CVPixelBufferGetBytesPerRow(src), dls = CVPixelBufferGetBytesPerRow(dst);
		if (_maskFormat == kCVPixelFormatType_OneComponent8) {
			for (int y = 0; y < h; y++)
				memcpy(dp + (size_t)y * dls, sp + (size_t)y * sls, (size_t)w);
		} else {
			for (int y = 0; y < h; y++) {
				const uint8_t *s = sp + (size_t)y * sls;
				uint32_t *d = (uint32_t *)(dp + (size_t)y * dls);
				for (int x = 0; x < w; x++)
					d[x] = 0x01010101u * s[x];
			}
		}
		CVPixelBufferUnlockBaseAddress(dst, 0);
		CVPixelBufferUnlockBaseAddress(src, kCVPixelBufferLock_ReadOnly);
		_mask_w = w;
		_mask_h = h;
		atomic_fetch_add(&_seq, 1);
		atomic_store(&_front, slot);
	}
}

// Graphics thread. Hands a libobs-owned Metal texture (retained by the block)
// to the provider; the blit into Vision's buffer runs on the provider queue.
- (void)submitMetalTexture:(id<MTLTexture>)tex fast:(BOOL)fast {
	if (!tex)
		return;
	if (atomic_exchange(&_busy, true))
		return;
	dispatch_async(_queue, ^{
		@autoreleasepool {
			[self blitAndSegment:tex fast:fast];
		}
		atomic_store(&self->_busy, false);
	});
}

// Provider queue only.
- (void)blitAndSegment:(id<MTLTexture>)tex fast:(BOOL)fast {
	int w = (int)tex.width, h = (int)tex.height;
	if (![self ensureFrame:w height:h])
		return;
	if (_device != tex.device) {
		if (_texCache)
			CFRelease(_texCache);
		_texCache = NULL;
		_device = tex.device;
		_cmdq = [_device newCommandQueue];
		CVMetalTextureCacheCreate(kCFAllocatorDefault, NULL, _device, NULL, &_texCache);
	}
	if (!_texCache || !_cmdq)
		return;
	CVMetalTextureRef cvtex = NULL;
	// Same pixel format as the libobs texture (BGRA8, sRGB-typed or not) so
	// the blit is a byte copy; the buffer is 32BGRA either way.
	CVReturn rc = CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, _texCache, _frame, NULL,
								tex.pixelFormat, (size_t)w, (size_t)h, 0, &cvtex);
	if (rc != kCVReturnSuccess || !cvtex)
		return;
	id<MTLTexture> dst = CVMetalTextureGetTexture(cvtex);
	id<MTLCommandBuffer> cmd = [_cmdq commandBuffer];
	id<MTLBlitCommandEncoder> blit = [cmd blitCommandEncoder];
	[blit copyFromTexture:tex
		     sourceSlice:0
		     sourceLevel:0
		    sourceOrigin:MTLOriginMake(0, 0, 0)
		      sourceSize:MTLSizeMake((NSUInteger)w, (NSUInteger)h, 1)
		       toTexture:dst
		destinationSlice:0
		destinationLevel:0
	       destinationOrigin:MTLOriginMake(0, 0, 0)];
	[blit endEncoding];
	[cmd commit];
	[cmd waitUntilCompleted];
	CFRelease(cvtex);
	[self segmentFast:fast];
}

// Graphics thread (OpenGL path). Copies BGRA rows into the frame buffer and
// queues Vision. The memcpy is the one cost paid on the graphics thread —
// about a megabyte at analysis size.
- (void)submitBGRA:(const uint8_t *)bytes linesize:(uint32_t)linesize width:(int)w height:(int)h fast:(BOOL)fast {
	if (!bytes)
		return;
	if (atomic_exchange(&_busy, true))
		return;
	if (![self ensureFrame:w height:h]) {
		atomic_store(&_busy, false);
		return;
	}
	CVPixelBufferLockBaseAddress(_frame, 0);
	uint8_t *dp = CVPixelBufferGetBaseAddress(_frame);
	size_t dls = CVPixelBufferGetBytesPerRow(_frame);
	size_t row = (size_t)w * 4;
	for (int y = 0; y < h; y++)
		memcpy(dp + (size_t)y * dls, bytes + (size_t)y * linesize, row);
	CVPixelBufferUnlockBaseAddress(_frame, 0);
	dispatch_async(_queue, ^{
		@autoreleasepool {
			[self segmentFast:fast];
		}
		atomic_store(&self->_busy, false);
	});
}

// Graphics thread. The newest completed mask, or NULL before the first.
- (IOSurfaceRef)latestSurface:(int *)slot seq:(uint64_t *)seq width:(int *)w height:(int *)h {
	int f = atomic_load(&_front);
	if (f < 0)
		return NULL;
	CVPixelBufferRef pb = _masks[f];
	if (!pb)
		return NULL;
	*slot = f;
	*seq = atomic_load(&_seq);
	*w = (int)CVPixelBufferGetWidth(pb);
	*h = (int)CVPixelBufferGetHeight(pb);
	return CVPixelBufferGetIOSurface(pb);
}

@end

// ── libobs filter ────────────────────────────────────────────────────────────

struct person_mask {
	obs_source_t *ctx;
	// ProducerSegmentation, held with CFBridgingRetain: the filter struct is
	// plain calloc'd C, so ARC never sees the field.
	void *seg;
	bool metal;

	gs_effect_t *effect;
	gs_eparam_t *p_image, *p_mask, *p_blurred, *p_blur_dir, *p_mask_texel, *p_feather, *p_erode;

	gs_texrender_t *src_tr;
	gs_texrender_t *ana_tr[PM_ANA_RING];
	int ana_i;
	uint32_t ana_w, ana_h;
	// OpenGL readback ring.
	gs_stagesurf_t *stage[2];
	bool stage_pending[2];
	int stage_i;
	uint32_t stage_w, stage_h;
	gs_texrender_t *blur_a, *blur_b;

	gs_texture_t *mask_tex[PM_MASK_RING];
	IOSurfaceID mask_id[PM_MASK_RING];

	int mode;
	float feather, erode, blur;
};

static const char *pm_name(void *unused)
{
	(void)unused;
	return "Cutout";
}

static void pm_defaults(obs_data_t *settings)
{
	obs_data_set_default_string(settings, "mode", "soft");
	obs_data_set_default_double(settings, "feather", 0.35);
	obs_data_set_default_double(settings, "erode", 0.25);
	obs_data_set_default_double(settings, "blur", 0.6);
}

static void pm_update(void *data, obs_data_t *settings)
{
	struct person_mask *f = data;
	const char *mode = obs_data_get_string(settings, "mode");
	if (mode && strcmp(mode, "cut") == 0)
		f->mode = PM_CUT;
	else if (mode && strcmp(mode, "soft") == 0)
		f->mode = PM_SOFT;
	else
		f->mode = PM_OFF;
	f->feather = (float)obs_data_get_double(settings, "feather");
	f->erode = (float)obs_data_get_double(settings, "erode");
	f->blur = (float)obs_data_get_double(settings, "blur");
}

static obs_properties_t *pm_properties(void *unused)
{
	(void)unused;
	obs_properties_t *props = obs_properties_create();
	obs_property_t *mode =
		obs_properties_add_list(props, "mode", "Mode", OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_STRING);
	obs_property_list_add_string(mode, "Off", "off");
	obs_property_list_add_string(mode, "Soft", "soft");
	obs_property_list_add_string(mode, "Cut", "cut");
	obs_properties_add_float_slider(props, "feather", "Feather", 0.0, 1.0, 0.01);
	obs_properties_add_float_slider(props, "erode", "Erode", 0.0, 1.0, 0.01);
	obs_properties_add_float_slider(props, "blur", "Blur radius", 0.0, 1.0, 0.01);
	return props;
}

static void pm_free_gpu(struct person_mask *f)
{
	if (f->effect)
		gs_effect_destroy(f->effect);
	if (f->src_tr)
		gs_texrender_destroy(f->src_tr);
	for (int i = 0; i < PM_ANA_RING; i++)
		if (f->ana_tr[i])
			gs_texrender_destroy(f->ana_tr[i]);
	for (int i = 0; i < 2; i++)
		if (f->stage[i])
			gs_stagesurface_destroy(f->stage[i]);
	if (f->blur_a)
		gs_texrender_destroy(f->blur_a);
	if (f->blur_b)
		gs_texrender_destroy(f->blur_b);
	for (int i = 0; i < PM_MASK_RING; i++)
		if (f->mask_tex[i])
			gs_texture_destroy(f->mask_tex[i]);
}

static void pm_destroy(void *data)
{
	struct person_mask *f = data;
	obs_enter_graphics();
	pm_free_gpu(f);
	obs_leave_graphics();
	// A block in flight on the provider queue holds its own reference; the
	// object outlives us by at most one segmentation.
	if (f->seg)
		CFBridgingRelease(f->seg);
	free(f);
}

static void *pm_create(obs_data_t *settings, obs_source_t *ctx)
{
	struct person_mask *f = calloc(1, sizeof(*f));
	if (!f)
		return NULL;
	f->ctx = ctx;

	obs_enter_graphics();
	f->metal = gs_get_device_type() == GS_DEVICE_METAL;
	char *err = NULL;
	f->effect = gs_effect_create(PRODUCER_PERSON_MASK_EFFECT, "person_mask.effect", &err);
	if (f->effect) {
		f->p_image = gs_effect_get_param_by_name(f->effect, "image");
		f->p_mask = gs_effect_get_param_by_name(f->effect, "mask");
		f->p_blurred = gs_effect_get_param_by_name(f->effect, "blurred");
		f->p_blur_dir = gs_effect_get_param_by_name(f->effect, "blur_dir");
		f->p_mask_texel = gs_effect_get_param_by_name(f->effect, "mask_texel");
		f->p_feather = gs_effect_get_param_by_name(f->effect, "feather");
		f->p_erode = gs_effect_get_param_by_name(f->effect, "erode");
		f->src_tr = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
		for (int i = 0; i < PM_ANA_RING; i++)
			f->ana_tr[i] = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
		f->blur_a = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
		f->blur_b = gs_texrender_create(GS_BGRA, GS_ZS_NONE);
	} else {
		blog(LOG_ERROR, "[person_mask] effect failed to compile: %s", err ? err : "?");
	}
	if (err)
		bfree(err);
	obs_leave_graphics();

	if (!f->effect) {
		pm_destroy(f);
		return NULL;
	}

	ProducerSegmentation *seg = [[ProducerSegmentation alloc] initWithBGRAMask:!f->metal];
	f->seg = seg ? (void *)CFBridgingRetain(seg) : NULL;
	if (!f->seg)
		blog(LOG_WARNING, "[person_mask] Vision person segmentation needs macOS 12; filter passes through");

	pm_update(f, settings);
	blog(LOG_INFO, "[person_mask] created (%s backend, %s)", f->metal ? "metal" : "opengl",
	     f->seg ? "vision ready" : "no provider");
	return f;
}

static void pm_fit(uint32_t cx, uint32_t cy, uint32_t *aw, uint32_t *ah)
{
	if (cx <= PM_ANALYSIS_MAX_W) {
		*aw = cx;
		*ah = cy;
		return;
	}
	*aw = PM_ANALYSIS_MAX_W;
	*ah = (uint32_t)((uint64_t)cy * PM_ANALYSIS_MAX_W / cx);
	if (*ah == 0)
		*ah = 1;
}

// Draw `tex` (logically cx×cy) into the current target with the given
// technique. Callers set the effect params and blend state.
static void pm_draw(gs_effect_t *effect, const char *tech_name, gs_eparam_t *image, gs_texture_t *tex, uint32_t cx,
		    uint32_t cy)
{
	gs_technique_t *tech = gs_effect_get_technique(effect, tech_name);
	if (!tech)
		return;
	gs_effect_set_texture_srgb(image, tex);
	size_t passes = gs_technique_begin(tech);
	for (size_t i = 0; i < passes; i++) {
		if (gs_technique_begin_pass(tech, i)) {
			gs_draw_sprite(tex, 0, cx, cy);
			gs_technique_end_pass(tech);
		}
	}
	gs_technique_end(tech);
}

// Render `tex` into `tr` at w×h with a technique of our effect.
static bool pm_pass(struct person_mask *f, gs_texrender_t *tr, uint32_t w, uint32_t h, const char *tech,
		    gs_texture_t *tex, uint32_t cx, uint32_t cy)
{
	gs_texrender_reset(tr);
	if (!gs_texrender_begin(tr, w, h))
		return false;
	struct vec4 clear = {0.0f, 0.0f, 0.0f, 0.0f};
	gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
	gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
	gs_blend_state_push();
	gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
	gs_enable_framebuffer_srgb(true);
	pm_draw(f->effect, tech, f->p_image, tex, cx, cy);
	gs_blend_state_pop();
	gs_texrender_end(tr);
	return true;
}

// The analysis half: downscale the frame into the ring and hand the entry
// rendered LAST frame to the provider.
static void pm_analyze(struct person_mask *f, gs_texture_t *src, uint32_t cx, uint32_t cy)
{
	uint32_t aw, ah;
	pm_fit(cx, cy, &aw, &ah);
	const BOOL fast = cy > PM_FAST_ABOVE_H;

	gs_texrender_t *cur = f->ana_tr[f->ana_i];
	gs_effect_t *def = obs_get_base_effect(OBS_EFFECT_DEFAULT);
	gs_eparam_t *def_image = def ? gs_effect_get_param_by_name(def, "image") : NULL;
	if (!def || !def_image)
		return;
	gs_texrender_reset(cur);
	if (gs_texrender_begin(cur, aw, ah)) {
		struct vec4 clear = {0.0f, 0.0f, 0.0f, 0.0f};
		gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
		gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
		gs_blend_state_push();
		gs_blend_function(GS_BLEND_ONE, GS_BLEND_ZERO);
		gs_enable_framebuffer_srgb(true);
		pm_draw(def, "Draw", def_image, src, cx, cy);
		gs_blend_state_pop();
		gs_texrender_end(cur);
	}
	// Two renders back, not one: preview and program each render the filter
	// once per frame, so the previous entry may be this same frame's.
	int prev_i = (f->ana_i + PM_ANA_RING - 2) % PM_ANA_RING;
	f->ana_i = (f->ana_i + 1) % PM_ANA_RING;
	ProducerSegmentation *seg = (__bridge ProducerSegmentation *)f->seg;

	if (f->metal) {
		gs_texture_t *prev = gs_texrender_get_texture(f->ana_tr[prev_i]);
		if (!prev || gs_texture_get_width(prev) != aw || gs_texture_get_height(prev) != ah)
			return; // first frames after a size change
		id<MTLTexture> mtl = (__bridge id<MTLTexture>)gs_texture_get_obj(prev);
		[seg submitMetalTexture:mtl fast:fast];
		return;
	}

	// OpenGL: two stage surfaces, map the one staged last frame.
	if (f->stage_w != aw || f->stage_h != ah) {
		for (int i = 0; i < 2; i++) {
			if (f->stage[i])
				gs_stagesurface_destroy(f->stage[i]);
			f->stage[i] = gs_stagesurface_create(aw, ah, GS_BGRA);
			f->stage_pending[i] = false;
		}
		f->stage_w = aw;
		f->stage_h = ah;
	}
	int other = (f->stage_i + 1) % 2;
	if (f->stage_pending[other] && f->stage[other]) {
		uint8_t *bytes = NULL;
		uint32_t linesize = 0;
		if (gs_stagesurface_map(f->stage[other], &bytes, &linesize)) {
			[seg submitBGRA:bytes linesize:linesize width:(int)aw height:(int)ah fast:fast];
			gs_stagesurface_unmap(f->stage[other]);
		}
		f->stage_pending[other] = false;
	}
	gs_texture_t *cur_tex = gs_texrender_get_texture(cur);
	if (cur_tex && f->stage[f->stage_i]) {
		gs_stage_texture(f->stage[f->stage_i], cur_tex);
		f->stage_pending[f->stage_i] = true;
	}
	f->stage_i = other;
}

// Bind the latest mask as a gs_texture, creating one per ring slot and
// recreating when the provider replaced the surface.
static gs_texture_t *pm_mask_texture(struct person_mask *f, int *mw, int *mh)
{
	int slot = 0;
	uint64_t seq = 0;
	ProducerSegmentation *seg = (__bridge ProducerSegmentation *)f->seg;
	IOSurfaceRef surf = [seg latestSurface:&slot seq:&seq width:mw height:mh];
	if (!surf)
		return NULL;
	IOSurfaceID sid = IOSurfaceGetID(surf);
	if (f->mask_tex[slot] && f->mask_id[slot] != sid) {
		gs_texture_destroy(f->mask_tex[slot]);
		f->mask_tex[slot] = NULL;
	}
	if (!f->mask_tex[slot]) {
		f->mask_tex[slot] = gs_texture_create_from_iosurface((void *)surf);
		f->mask_id[slot] = sid;
		if (!f->mask_tex[slot]) {
			static int logged = 0;
			if (logged++ < 3)
				blog(LOG_WARNING, "[person_mask] mask IOSurface %u could not be bound", (unsigned)sid);
		}
	}
	return f->mask_tex[slot];
}

static void pm_render(void *data, gs_effect_t *unused)
{
	(void)unused;
	struct person_mask *f = data;
	obs_source_t *target = obs_filter_get_target(f->ctx);
	uint32_t cx = target ? obs_source_get_base_width(target) : 0;
	uint32_t cy = target ? obs_source_get_base_height(target) : 0;
	if (f->mode == PM_OFF || !f->seg || !f->effect || !cx || !cy) {
		obs_source_skip_video_filter(f->ctx);
		return;
	}
	// SDR only, like the color key: an EDR canvas bypasses the cutout rather
	// than tone-mapping through an 8-bit texrender.
	const enum gs_color_space preferred[] = {GS_CS_SRGB};
	if (obs_source_get_color_space(target, 1, preferred) != GS_CS_SRGB) {
		obs_source_skip_video_filter(f->ctx);
		return;
	}

	const bool prev_linear = gs_set_linear_srgb(true);
	const bool prev_fb_srgb = gs_framebuffer_srgb_enabled();

	// 1. The target, rendered to texture exactly as process_filter_begin does.
	gs_texrender_reset(f->src_tr);
	gs_blend_state_push();
	gs_blend_function_separate(GS_BLEND_SRCALPHA, GS_BLEND_INVSRCALPHA, GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
	if (gs_texrender_begin_with_color_space(f->src_tr, cx, cy, GS_CS_SRGB)) {
		struct vec4 clear = {0.0f, 0.0f, 0.0f, 0.0f};
		gs_clear(GS_CLEAR_COLOR, &clear, 0.0f, 0);
		gs_ortho(0.0f, (float)cx, 0.0f, (float)cy, -100.0f, 100.0f);
		obs_source_video_render(target);
		gs_texrender_end(f->src_tr);
	}
	gs_blend_state_pop();
	gs_texture_t *src = gs_texrender_get_texture(f->src_tr);
	if (!src) {
		gs_set_linear_srgb(prev_linear);
		obs_source_skip_video_filter(f->ctx);
		return;
	}

	// 2. Feed the provider (never blocks: see the header).
	pm_analyze(f, src, cx, cy);

	// 3. Latest mask. Before the first one lands, draw the frame untouched.
	int mw = 0, mh = 0;
	gs_texture_t *mask = pm_mask_texture(f, &mw, &mh);
	gs_effect_t *def = obs_get_base_effect(OBS_EFFECT_DEFAULT);
	gs_enable_framebuffer_srgb(true);
	if (!mask || mw <= 0 || mh <= 0) {
		gs_eparam_t *def_image = def ? gs_effect_get_param_by_name(def, "image") : NULL;
		if (def && def_image)
			pm_draw(def, "Draw", def_image, src, cx, cy);
		gs_enable_framebuffer_srgb(prev_fb_srgb);
		gs_set_linear_srgb(prev_linear);
		return;
	}

	// 4. Soft: separable blur at half resolution, horizontal then vertical.
	gs_texture_t *blurred = NULL;
	if (f->mode == PM_SOFT) {
		uint32_t bw = cx / 2 > 0 ? cx / 2 : 1, bh = cy / 2 > 0 ? cy / 2 : 1;
		float step = 1.0f + f->blur * PM_BLUR_TEXELS;
		struct vec2 dir = {step / (float)bw, 0.0f};
		gs_effect_set_vec2(f->p_blur_dir, &dir);
		if (pm_pass(f, f->blur_a, bw, bh, "Blur", src, cx, cy)) {
			gs_texture_t *a = gs_texrender_get_texture(f->blur_a);
			struct vec2 dir_v = {0.0f, step / (float)bh};
			gs_effect_set_vec2(f->p_blur_dir, &dir_v);
			if (a && pm_pass(f, f->blur_b, bw, bh, "Blur", a, cx, cy))
				blurred = gs_texrender_get_texture(f->blur_b);
		}
	}

	// 5. Composite into the caller's target, premultiplied like the color key.
	gs_effect_set_texture(f->p_mask, mask);
	if (blurred)
		gs_effect_set_texture_srgb(f->p_blurred, blurred);
	struct vec2 texel = {1.0f / (float)mw, 1.0f / (float)mh};
	gs_effect_set_vec2(f->p_mask_texel, &texel);
	gs_effect_set_float(f->p_feather, f->feather);
	gs_effect_set_float(f->p_erode, f->erode * PM_ERODE_TEXELS);
	gs_blend_state_push();
	gs_blend_function(GS_BLEND_ONE, GS_BLEND_INVSRCALPHA);
	pm_draw(f->effect, (f->mode == PM_SOFT && blurred) ? "Soft" : "Cut", f->p_image, src, cx, cy);
	gs_blend_state_pop();

	gs_enable_framebuffer_srgb(prev_fb_srgb);
	gs_set_linear_srgb(prev_linear);
}

void producer_person_mask_register_native(void)
{
	struct obs_source_info info;
	memset(&info, 0, sizeof(info));
	info.id = PRODUCER_PERSON_MASK_ID;
	info.type = OBS_SOURCE_TYPE_FILTER;
	info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_SRGB;
	info.get_name = pm_name;
	info.create = pm_create;
	info.destroy = pm_destroy;
	info.get_defaults = pm_defaults;
	info.get_properties = pm_properties;
	info.update = pm_update;
	info.video_render = pm_render;
	obs_register_source_s(&info, sizeof(info));
}
