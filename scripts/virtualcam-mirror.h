#pragma once
#include <Accelerate/Accelerate.h>
#include <stddef.h>
// Input OBS frame and output camera pixel buffer are distinct allocations.
// Reflection moves complete BGRA pixels; channel order and alpha stay intact.
static inline vImage_Error producer_mirror_bgra(const void *source, size_t source_row,
    void *destination, size_t destination_row, size_t width, size_t height)
{
    vImage_Buffer src = {(void *) source, height, width, source_row};
    vImage_Buffer dst = {destination, height, width, destination_row};
    return vImageHorizontalReflect_ARGB8888(&src, &dst, kvImageDoNotTile);
}
