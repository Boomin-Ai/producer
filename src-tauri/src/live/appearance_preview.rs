//! Bounded return thumbnails. Compression never runs on the shared PCM broker.
use producer_guest_runtime::media::Video;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{sync_channel, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
struct Picture {
    width: u32,
    height: u32,
    strides: (u32, u32, u32),
    planes: (Vec<u8>, Vec<u8>, Vec<u8>),
    generation: u64,
    at: Instant,
}
pub struct PreviewLane {
    sender: Mutex<Option<SyncSender<Picture>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    jpeg: Arc<Mutex<Vec<u8>>>,
    generation: Arc<AtomicU64>,
    last: Mutex<Instant>,
}
fn dimensions(width: u32, height: u32) -> (u32, u32) {
    let longest = width.max(height).max(640);
    (
        (u64::from(width) * 640 / u64::from(longest)).max(1) as u32,
        (u64::from(height) * 640 / u64::from(longest)).max(1) as u32,
    )
}
fn compress(frame: &Picture) -> Option<Vec<u8>> {
    let (width, height) = dimensions(frame.width, frame.height);
    let mut pixels = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        let sy = y * frame.height / height;
        for x in 0..width {
            let sx = x * frame.width / width;
            pixels.extend_from_slice(&[
                *frame.planes.0.get((sy * frame.strides.0 + sx) as usize)?,
                *frame
                    .planes
                    .1
                    .get(((sy / 2) * frame.strides.1 + sx / 2) as usize)?,
                *frame
                    .planes
                    .2
                    .get(((sy / 2) * frame.strides.2 + sx / 2) as usize)?,
            ]);
        }
    }
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, 75)
        .encode(
            &pixels,
            width as u16,
            height as u16,
            jpeg_encoder::ColorType::Ycbcr,
        )
        .ok()?;
    Some(jpeg)
}
impl PreviewLane {
    pub fn new() -> Result<Self, String> {
        let (sender, receiver) = sync_channel::<Picture>(1);
        let jpeg = Arc::new(Mutex::new(Vec::new()));
        let image = jpeg.clone();
        let generation = Arc::new(AtomicU64::new(1));
        let epoch = generation.clone();
        let worker = thread::Builder::new()
            .name("appearance-return-preview".into())
            .spawn(move || {
                while let Ok(frame) = receiver.recv() {
                    if frame.at.elapsed() > Duration::from_millis(500)
                        || epoch.load(Ordering::Acquire) != frame.generation
                    {
                        continue;
                    }
                    if let Some(bytes) = compress(&frame) {
                        if let Ok(mut image) = image.lock() {
                            if epoch.load(Ordering::Acquire) == frame.generation {
                                *image = bytes;
                            }
                        }
                    }
                }
            })
            .map_err(|_| "Native appearance preview worker unavailable")?;
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            worker: Mutex::new(Some(worker)),
            jpeg,
            generation,
            last: Mutex::new(Instant::now() - Duration::from_secs(1)),
        })
    }
    pub fn offer(&self, frame: &Video<'_>) {
        if frame.width == 0 || frame.height == 0 || frame.width > 4096 || frame.height > 4096 {
            return;
        }
        let Ok(mut last) = self.last.try_lock() else {
            return;
        };
        if last.elapsed() < Duration::from_millis(200) {
            return;
        }
        let Ok(sender) = self.sender.try_lock() else {
            return;
        };
        let Some(sender) = sender.as_ref() else {
            return;
        };
        // The borrowed SDK planes cannot outlive this call. Only this bounded
        // ownership copy runs here; scaling and JPEG run on the private worker.
        let picture = Picture {
            width: frame.width,
            height: frame.height,
            strides: frame.strides,
            planes: (
                frame.planes.0.to_vec(),
                frame.planes.1.to_vec(),
                frame.planes.2.to_vec(),
            ),
            generation: self.generation.load(Ordering::Acquire),
            at: Instant::now(),
        };
        let _ = sender.try_send(picture);
        *last = Instant::now();
    }
    pub fn image(&self) -> Vec<u8> {
        self.jpeg.lock().map(|v| v.clone()).unwrap_or_default()
    }
    pub fn clear(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(mut jpeg) = self.jpeg.lock() {
            jpeg.clear();
        }
    }
    pub fn close(&self) {
        self.clear();
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
        self.clear();
    }
}
impl Drop for PreviewLane {
    fn drop(&mut self) {
        self.close();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn both_orientations_bound_thumbnail_work() {
        assert_eq!(dimensions(1280, 720), (640, 360));
        assert_eq!(dimensions(720, 1280), (360, 640));
        assert_eq!(dimensions(1920, 1080), (640, 360));
        assert_eq!(dimensions(1080, 1920), (360, 640));
    }
    #[test]
    fn stale_work_cannot_reappear_after_invalidation_or_close() {
        let lane = PreviewLane::new().unwrap();
        let y = vec![16; 1280 * 720];
        let uv = vec![128; 640 * 360];
        lane.offer(&Video {
            planes: (&y, &uv, &uv),
            width: 1280,
            height: 720,
            strides: (1280, 640, 640),
        });
        lane.clear();
        lane.close();
        assert!(lane.image().is_empty());
        lane.offer(&Video {
            planes: (&y, &uv, &uv),
            width: 1280,
            height: 720,
            strides: (1280, 640, 640),
        });
        assert!(lane.image().is_empty());
        lane.close();
    }
}
