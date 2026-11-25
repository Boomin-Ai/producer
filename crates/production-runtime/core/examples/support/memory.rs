use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::atomic::{AtomicUsize, Ordering},
};
struct Tracked;
thread_local! { static THREAD_CALLS: Cell<usize> = const { Cell::new(0) }; }
static CALLS: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);
static LARGE_CALLS: AtomicUsize = AtomicUsize::new(0);
static LARGE_BYTES: AtomicUsize = AtomicUsize::new(0);
fn large(size: usize) {
    CALLS.fetch_add(1, Ordering::Relaxed);
    let _ = THREAD_CALLS.try_with(|n| n.set(n.get().wrapping_add(1)));
    if size >= 1024 * 1024 {
        LARGE_CALLS.fetch_add(1, Ordering::Relaxed);
        LARGE_BYTES.fetch_add(size, Ordering::Relaxed);
    }
}
pub fn allocations() -> usize {
    CALLS.load(Ordering::Relaxed)
}
pub fn thread_allocations() -> usize {
    THREAD_CALLS.with(Cell::get)
}
pub fn large_calls() -> usize {
    LARGE_CALLS.load(Ordering::Relaxed)
}
pub fn large_bytes() -> usize {
    LARGE_BYTES.load(Ordering::Relaxed)
}
unsafe impl GlobalAlloc for Tracked {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            large(l.size());
            let live = LIVE.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        LIVE.fetch_sub(l.size(), Ordering::Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            large(n);
            LIVE.fetch_sub(l.size(), Ordering::Relaxed);
            let live = LIVE.fetch_add(n, Ordering::Relaxed) + n;
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        q
    }
}
#[global_allocator]
static A: Tracked = Tracked;
// Test-process-only memory sampling. No desktop process or GPU is inspected.
#[cfg(target_os = "macos")]
#[allow(
    deprecated,
    reason = "Test-process-only RSS sampling uses the already locked libc Mach bindings"
)]
pub fn rss() -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::mach_task_basic_info_data_t>::zeroed();
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    // SAFETY: self task, correct flavor, buffer type/size and writable count.
    let result = unsafe {
        libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            info.as_mut_ptr().cast(),
            &mut count,
        )
    };
    if result != libc::KERN_SUCCESS || count != libc::MACH_TASK_BASIC_INFO_COUNT {
        return None;
    }
    Some(unsafe { info.assume_init() }.resident_size)
}
#[cfg(target_os = "linux")]
pub fn rss() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages = stat.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    // SAFETY: read-only sysconf query, no pointers.
    let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    pages.checked_mul(u64::try_from(size).ok()?)
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn rss() -> Option<u64> {
    None
}

pub fn live() -> usize {
    LIVE.load(Ordering::Relaxed)
}
pub fn peak() -> usize {
    PEAK.load(Ordering::Relaxed)
}
pub fn reset_peak() {
    PEAK.store(live(), Ordering::Relaxed);
}
#[cfg(target_os = "macos")]
pub fn allocator() -> Option<serde_json::Value> {
    let mut info = std::mem::MaybeUninit::<libc::malloc_statistics_t>::zeroed();
    // SAFETY: documented NULL zone requests aggregate statistics for this process.
    unsafe {
        libc::malloc_zone_statistics(std::ptr::null_mut(), info.as_mut_ptr());
    }
    let info = unsafe { info.assume_init() };
    let mut proc = std::mem::MaybeUninit::<libc::proc_taskinfo>::zeroed();
    // SAFETY: current PID, correct flavor and writable buffer/size.
    let len = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            proc.as_mut_ptr().cast(),
            std::mem::size_of::<libc::proc_taskinfo>() as i32,
        )
    };
    let proc_resident = if len == std::mem::size_of::<libc::proc_taskinfo>() as i32 {
        Some(unsafe { proc.assume_init() }.pti_resident_size)
    } else {
        None
    };
    let mut ru = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: self-process read-only resource query and correctly sized writable output.
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, ru.as_mut_ptr()) };
    let peak = if result == 0 {
        Some(unsafe { ru.assume_init() }.ru_maxrss)
    } else {
        None
    };
    Some(
        serde_json::json!({"blocksInUse":info.blocks_in_use,"bytesInUse":info.size_in_use,"reservedBytes":info.size_allocated,"touchedHighWaterBytes":info.max_size_in_use,"procResidentBytes":proc_resident,"maxRssBytes":peak}),
    )
}
#[cfg(not(target_os = "macos"))]
pub fn allocator() -> Option<serde_json::Value> {
    None
}
