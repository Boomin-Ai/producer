#include <AudioToolbox/AudioToolbox.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

enum { BlockFrames = 480, MonitorBuffers = 4 };
static AudioStreamBasicDescription stereo(void) {
    return (AudioStreamBasicDescription){
        .mSampleRate = 48000,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagsNativeFloatPacked,
        .mBytesPerPacket = 8,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = 8,
        .mChannelsPerFrame = 2,
        .mBitsPerChannel = 32,
    };
}

// All file access and conversion run on the decoder thread.
void *studio_audio_open(const char *path) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, strlen(path), false);
    if (!url) return NULL;
    ExtAudioFileRef file = NULL;
    OSStatus status = ExtAudioFileOpenURL(url, &file);
    CFRelease(url);
    if (status != noErr || !file) return NULL;
    AudioStreamBasicDescription format = stereo();
    if (ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, sizeof(format), &format) != noErr) {
        ExtAudioFileDispose(file);
        return NULL;
    }
    return file;
}

int studio_audio_read(void *file, float *out, UInt32 frames) {
    AudioBufferList buffer = {.mNumberBuffers = 1, .mBuffers = {{2, frames * 8, out}}};
    return ExtAudioFileRead(file, &frames, &buffer) == noErr ? (int)frames : -1;
}
void studio_audio_close(void *file) { ExtAudioFileDispose(file); }

typedef struct {
    AudioQueueRef queue;
    AudioQueueBufferRef buffers[MonitorBuffers];
    atomic_uint available;
    int started;
} Monitor;

static void returned(void *context, AudioQueueRef queue, AudioQueueBufferRef buffer) {
    (void)queue;
    Monitor *monitor = context;
    for (unsigned slot = 0; slot < MonitorBuffers; ++slot) {
        if (monitor->buffers[slot] == buffer) {
            atomic_fetch_or(&monitor->available, 1u << slot);
            return;
        }
    }
}

void *studio_monitor_open(void) {
    Monitor *monitor = calloc(1, sizeof(*monitor));
    if (!monitor) return NULL;
    AudioStreamBasicDescription format = stereo();
    if (AudioQueueNewOutput(&format, returned, monitor, NULL, NULL, 0, &monitor->queue) != noErr) {
        free(monitor);
        return NULL;
    }
    for (unsigned slot = 0; slot < MonitorBuffers; ++slot) {
        if (AudioQueueAllocateBuffer(monitor->queue, BlockFrames * 8, &monitor->buffers[slot]) != noErr) {
            AudioQueueDispose(monitor->queue, true);
            free(monitor);
            return NULL;
        }
    }
    atomic_init(&monitor->available, (1u << MonitorBuffers) - 1u);
    return monitor;
}

// Only the monitor worker enqueues. The callback just returns a buffer slot.
int studio_monitor_write(void *context, const float *samples) {
    Monitor *monitor = context;
    unsigned free_slots = atomic_load(&monitor->available);
    if (!free_slots) return 0;
    unsigned slot = (unsigned)__builtin_ctz(free_slots);
    atomic_fetch_and(&monitor->available, ~(1u << slot));
    AudioQueueBufferRef buffer = monitor->buffers[slot];
    memcpy(buffer->mAudioData, samples, BlockFrames * 8);
    buffer->mAudioDataByteSize = BlockFrames * 8;
    if (AudioQueueEnqueueBuffer(monitor->queue, buffer, 0, NULL) != noErr) {
        atomic_fetch_or(&monitor->available, 1u << slot);
        return -1;
    }
    if (!monitor->started) {
        if (AudioQueueStart(monitor->queue, NULL) != noErr) return -1;
        monitor->started = 1;
    }
    return 1;
}

void studio_monitor_close(void *context) {
    Monitor *monitor = context;
    AudioQueueDispose(monitor->queue, true);
    free(monitor);
}
