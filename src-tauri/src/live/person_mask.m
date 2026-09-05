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
