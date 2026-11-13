//! Bounded MP4 movie-duration probe for finalized replay clips. No media decode.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
fn header(f: &mut File, at: u64, end: u64) -> Result<(u64, u64, [u8; 4]), String> {
    if end.saturating_sub(at) < 8 {
        return Err("Truncated clip container".into());
    }
    f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
    let mut h = [0; 8];
    f.read_exact(&mut h).map_err(|e| e.to_string())?;
    let n = u32::from_be_bytes(h[..4].try_into().unwrap());
    let (size, len) = match n {
        0 => (end - at, 8),
        1 => {
            let mut b = [0; 8];
            f.read_exact(&mut b).map_err(|e| e.to_string())?;
            (u64::from_be_bytes(b), 16)
        }
        _ => (n as u64, 8),
    };
    if size < len || size > end - at {
        return Err("Incomplete clip container".into());
    }
    Ok((size, len, h[4..].try_into().unwrap()))
}
pub fn duration_ms(path: &Path) -> Result<i64, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let end = f.metadata().map_err(|e| e.to_string())?.len();
    let mut at = 0;
    let mut count = 0;
    while at < end {
        count += 1;
        if count > 4096 {
            return Err("Clip has too many container boxes".into());
        }
        let (size, len, kind) = header(&mut f, at, end)?;
        if &kind == b"moov" {
            let limit = at + size;
            let mut child = at + len;
            while child < limit {
                count += 1;
                if count > 4096 {
                    return Err("Clip has too many container boxes".into());
                }
                let (n, hlen, k) = header(&mut f, child, limit)?;
                if &k == b"mvhd" {
                    if n < hlen + 4 {
                        return Err("Clip duration is missing".into());
                    }
                    let mut v = [0; 4];
                    f.read_exact(&mut v).map_err(|e| e.to_string())?;
                    let skip = match v[0] {
                        0 => 8,
                        1 => 16,
                        _ => return Err("Unsupported clip movie header".into()),
                    };
                    let needed = if v[0] == 0 { 4 } else { 8 };
                    if n < hlen + 4 + skip + 4 + needed {
                        return Err("Clip duration is incomplete".into());
                    }
                    f.seek(SeekFrom::Current(skip as i64))
                        .map_err(|e| e.to_string())?;
                    let mut scale = [0; 4];
                    f.read_exact(&mut scale).map_err(|e| e.to_string())?;
                    let scale = u32::from_be_bytes(scale) as u64;
                    let duration = if v[0] == 0 {
                        let mut b = [0; 4];
                        f.read_exact(&mut b).map_err(|e| e.to_string())?;
                        u32::from_be_bytes(b) as u64
                    } else {
                        let mut b = [0; 8];
                        f.read_exact(&mut b).map_err(|e| e.to_string())?;
                        u64::from_be_bytes(b)
                    };
                    if scale == 0
                        || duration == 0
                        || duration == u64::MAX
                        || duration == u32::MAX as u64
                    {
                        return Err("Clip has no finalized duration".into());
                    }
                    return i64::try_from((duration as u128) * 1000 / (scale as u128))
                        .map_err(|_| "Clip duration is too large".into());
                }
                child += n;
            }
        }
        at += size;
    }
    Err("Clip movie duration was not found".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn atom(k: &[u8; 4], b: &[u8]) -> Vec<u8> {
        [(b.len() as u32 + 8).to_be_bytes().as_slice(), k, b].concat()
    }
    fn check(version: u8) -> Vec<u8> {
        let mut mvhd = vec![version, 0, 0, 0];
        mvhd.extend(vec![0; if version == 1 { 16 } else { 8 }]);
        mvhd.extend(1000u32.to_be_bytes());
        if version == 1 {
            mvhd.extend(12450u64.to_be_bytes())
        } else {
            mvhd.extend(12450u32.to_be_bytes())
        }
        atom(b"moov", &atom(b"mvhd", &mvhd))
    }
    fn probe(bytes: &[u8]) -> Result<i64, String> {
        let p = std::env::temp_dir().join(format!(
            "producer-duration-{}-{:?}.mp4",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(&p, bytes).unwrap();
        let result = duration_ms(&p);
        let _ = std::fs::remove_file(p);
        result
    }
    #[test]
    fn reads_both_movie_header_versions() {
        for v in [0, 1] {
            assert_eq!(probe(&check(v)).unwrap(), 12450)
        }
    }
    #[test]
    fn skips_media_data() {
        let mut b = atom(b"mdat", &[0; 4096]);
        b.extend(check(0));
        assert_eq!(probe(&b).unwrap(), 12450)
    }
    #[test]
    fn refuses_truncated_duration() {
        let mut b = check(1);
        b.pop();
        assert!(probe(&b).is_err());
        assert!(probe(&[0; 7]).is_err())
    }
    #[test]
    fn refuses_unknown_or_zero_duration() {
        assert!(probe(&atom(b"ftyp", b"mp42")).is_err());
        let mut b = check(0);
        let n = b.len();
        b[n - 4..].fill(0);
        assert!(probe(&b).is_err())
    }
}
