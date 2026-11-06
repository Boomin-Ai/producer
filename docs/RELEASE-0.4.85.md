# Producer 0.4.85

On Apple Silicon, Producer batches the Metal readback of video planes so the graphics thread spends less time waiting for pixels to reach the CPU. In the controlled test using the 720p I420 guest return format, this reduced time spent staging and mapping video frames while preserving frame order.
