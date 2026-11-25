use super::*;
use rune::native_surface::{ByteFrame, ColorInfo, Format, Matrix, Transfer};
use std::sync::Weak;
extern "C" {
    fn nr_monitor_planes(
        pixel: *mut std::ffi::c_void,
        w: usize,
        h: usize,
        y: *mut u8,
        uv: *mut u8,
    ) -> i32;
}
fn pack(f: &Frame) -> Option<ByteFrame> {
    let (w, h) = (f.width, f.height);
    if w > 16384 || h > 16384 || w == 0 || h == 0 || (w | h) % 2 != 0 {
        return None;
    }
    let n = w.checked_mul(h)?;
    let mut y = vec![0; n];
    let mut uv = vec![0; n / 2];
    // The Arc at the call site owns the completed pixel for the duration of this copy.
    let fmt = unsafe { nr_monitor_planes(f.ptr.as_ptr(), w, h, y.as_mut_ptr(), uv.as_mut_ptr()) };
    Some(ByteFrame {
        width: w as u32,
        height: h as u32,
        format: match fmt {
            0 => Format::Nv12Video,
            1 => Format::Nv12Full,
            _ => return None,
        },
        color: ColorInfo {
            matrix: Matrix::Bt601,
            transfer: Transfer::Bt709,
        },
        planes: [y, uv],
    })
}
pub(super) fn spawn(
    handle: Arc<Handle>,
    surfaces: [NativeSurface; 2],
    guest_thumbnail: NativeSurface,
    previewing: Arc<AtomicBool>,
    reviewing: Arc<AtomicBool>,
    guest_view: Arc<AtomicBool>,
) -> anyhow::Result<std::thread::JoinHandle<()>> {
    let closed = handle.closed.clone();
    let job = std::thread::Builder::new()
        .name("studio-monitor".into())
        .spawn(move || {
            let mut previous: [Weak<Frame>; 2] = Default::default();
            let mut last_guest = Weak::new();
            let mut seq = 0;
            while !handle.closed.load(Ordering::Acquire) {
                let start = Instant::now();
                let frame = handle.rtc_feed.lock().unwrap().as_ref().and_then(|feed| feed.thumbnail());
                if let Some(f) = frame {
                    let current = Arc::downgrade(&f);
                    if !last_guest.ptr_eq(&current) {
                        if let Some(bytes) = pack(&f) {
                            seq += 1;
                            if guest_thumbnail.push_bytes(bytes, seq).is_ok() { last_guest = current; }
                        }
                    }
                }
                let bus = if reviewing.load(Ordering::Acquire) {
                    &handle.set_edit_media
                } else if previewing.load(Ordering::Acquire) {
                    &handle.preview_media
                } else {
                    &handle.media
                };
                let media = bus.lock().unwrap().clone();
                {
                    let guest = guest_view.load(Ordering::Acquire);
                    for (i, surface) in surfaces.iter().enumerate() {
                        let next = if guest {
                            if i > 0 {
                                continue;
                            }
                            handle
                                .rtc_feed
                                .lock()
                                .unwrap()
                                .as_ref()
                                .and_then(|g| g.frame())
                        } else {
                            media.as_ref().and_then(|m| m.frame(i + 3))
                        };
                        if let Some(frame) = next {
                            let current = Arc::downgrade(&frame);
                            if previous[i].ptr_eq(&current) {
                                continue;
                            }
                            if let Some(pixels) = pack(&frame) {
                                drop(frame);
                                seq += 1;
                                if surface.push_bytes(pixels, seq).is_ok() {
                                    previous[i] = current;
                                }
                            }
                        }
                    }
                }
                std::thread::sleep(
                    Duration::from_secs_f64(1. / 30.).saturating_sub(start.elapsed()),
                );
            }
        });
    if job.is_err() {
        closed.store(true, Ordering::Release);
    }
    Ok(job?)
}
