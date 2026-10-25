//! Room-scoped authorized resources. Imported packages choose content IDs and
//! bounded bytes; they never choose native source types, paths, URLs or kernels.
use super::super::ffi;
use super::{
    contract::{Asset, Plan, Shader},
    Source,
};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::CString,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Weak,
    },
};
struct FileLease {
    path: PathBuf,
    owned: bool,
}
impl Drop for FileLease {
    fn drop(&mut self) {
        if self.owned {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
struct Cached {
    fingerprint: String,
    mime: String,
    file: Arc<FileLease>,
    bytes: usize,
}
pub struct Store {
    images: std::cell::RefCell<HashMap<String, std::rc::Weak<Source>>>,
    scenes3d: std::cell::RefCell<HashMap<String, std::rc::Weak<super::scene3d::Lease>>>,
    directory: PathBuf,
    assets: HashMap<String, Cached>,
    files: HashMap<String, Weak<FileLease>>,
}
impl Store {
    pub fn new() -> Result<Self, String> {
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        let directory = std::env::temp_dir().join(format!(
            "producer-sets-v2-resources-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        Ok(Self {
            images: Default::default(),
            scenes3d: Default::default(),
            directory,
            assets: HashMap::new(),
            files: HashMap::new(),
        })
    }
    pub fn publish(&mut self, assets: &HashMap<String, Asset>) -> Result<(), String> {
        let mut next = HashMap::new();
        for (id, a) in assets {
            let fingerprint = format!("{:x}", Sha256::digest(a.data.as_bytes()));
            if self
                .assets
                .get(id)
                .is_some_and(|c| c.fingerprint == fingerprint && c.mime == a.mime)
            {
                continue;
            }
            let (file, bytes) = if a.data.starts_with("producer-media:") {
                let path = crate::set_media::native_path(&a.data, &a.mime)?;
                (Arc::new(FileLease { path, owned: false }), 0)
            } else {
                let prefix = format!("data:{};base64,", a.mime);
                let encoded = a
                    .data
                    .strip_prefix(&prefix)
                    .ok_or("Set asset does not match its MIME")?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| "Invalid set asset encoding")?;
                if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
                    return Err("Embedded media byte budget exceeded".into());
                }
                let digest = format!("{:x}", Sha256::digest(&bytes));
                let file = if let Some(file) = self.files.get(&digest).and_then(Weak::upgrade) {
                    file
                } else {
                    let ext = match a.mime.as_str() {
                        "image/png" => "png",
                        "image/jpeg" => "jpg",
                        "image/webp" => "webp",
                        "image/gif" => "gif",
                        "video/mp4" => "mp4",
                        "video/webm" => "webm",
                        "video/quicktime" => "mov",
                        _ => return Err("Unsupported embedded media".into()),
                    };
                    let path = self.directory.join(format!("{digest}.{ext}"));
                    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
                    let file = Arc::new(FileLease { path, owned: true });
                    self.files.insert(digest, Arc::downgrade(&file));
                    file
                };
                (file, bytes.len())
            };
            next.insert(
                id.clone(),
                Cached {
                    fingerprint,
                    mime: a.mime.clone(),
                    file,
                    bytes,
                },
            );
        }
        let total: usize = self
            .assets
            .iter()
            .filter(|(id, _)| !next.contains_key(*id))
            .map(|(_, c)| c.bytes)
            .sum::<usize>()
            + next.values().map(|c| c.bytes).sum::<usize>();
        if total > 40 * 1024 * 1024
            || self
                .assets
                .keys()
                .chain(next.keys())
                .collect::<HashSet<_>>()
                .len()
                > 24
        {
            return Err("Room media cache budget exceeded".into());
        }
        self.assets.extend(next);
        self.files.retain(|_, f| f.strong_count() > 0);
        Ok(())
    }
    // Ready scene leases own their files/decoders independently of upload manifests.
    pub fn clear_manifest(&mut self) {
        self.assets.clear();
        self.files.retain(|_, file| file.strong_count() > 0);
    }
    pub fn versions(&self, resources: &[String]) -> String {
        let mut versions = resources
            .iter()
            .filter_map(|r| {
                r.strip_prefix("asset:").and_then(|id| {
                    self.assets
                        .get(id)
                        .map(|a| format!("{id}:{}", a.fingerprint))
                })
            })
            .collect::<Vec<_>>();
        versions.sort();
        versions.join("|")
    }
    pub unsafe fn open(&self, plan: &Plan) -> Result<Prepared, String> {
        let mut out = Prepared {
            sources: HashMap::new(),
            files: Vec::new(),
            shaders: Vec::new(),
            media: Vec::new(),
            scenes3d: HashMap::new(),
        };
        let mut nodes = Vec::new();
        fn visit<'a>(n: &'a super::contract::Node, out: &mut Vec<&'a super::contract::Node>) {
            out.push(n);
            for c in &n.children {
                visit(c, out);
            }
        }
        visit(&plan.root, &mut nodes);
        for n in nodes {
            let Some(resource) = &n.resource else {
                continue;
            };
            if out.sources.contains_key(resource) {
                continue;
            }
            if n.kind == "scene3d" {
                let key = resource
                    .strip_prefix("scene3d:")
                    .ok_or("Invalid 3D resource")?;
                let spec = plan.scenes3d.get(key).ok_or("Missing 3D definition")?;
                let w = n.bounds.width.ceil() as u32;
                let h = n.bounds.height.ceil() as u32;
                let identity = super::scene3d::key(
                    &format!("{}:{}", plan.definition_id, plan.instance_id),
                    spec,
                    w,
                    h,
                );
                let mut cache = self.scenes3d.borrow_mut();
                cache.retain(|_, v| v.strong_count() > 0);
                let lease =
                    if let Some(lease) = cache.get(&identity).and_then(std::rc::Weak::upgrade) {
                        lease
                    } else {
                        if cache.len() >= 6
                            || cache
                                .values()
                                .filter_map(std::rc::Weak::upgrade)
                                .map(|l| l.pixels())
                                .sum::<usize>()
                                + (w as usize) * (h as usize)
                                > 24 * 1024 * 1024
                        {
                            return Err("3D renderer context budget reached".into());
                        }
                        let lease = super::scene3d::Lease::create(spec, w, h)?;
                        cache.insert(identity, std::rc::Rc::downgrade(&lease));
                        lease
                    };
                out.sources.insert(resource.clone(), lease.source.clone());
                out.scenes3d.insert(key.to_string(), lease);
            } else if n.kind == "shader" {
                let key = resource
                    .strip_prefix("shader:")
                    .ok_or("Invalid material identity")?;
                let spec = plan.shaders.get(key).ok_or("Missing material definition")?;
                let source = shader_source(spec, n.bounds.width, n.bounds.height)?;
                let (show, segment, running) =
                    super::contract::clock_positions(plan.clock.as_ref());
                let base = if spec.clock == "segment" {
                    segment
                } else {
                    show
                };
                out.shaders.push(ShaderBinding {
                    source: source.0,
                    intensity: spec.intensity,
                    scale: spec.scale,
                    opacity: spec.opacity,
                    base_ms: base,
                    running,
                });
                out.sources
                    .insert(resource.clone(), std::rc::Rc::new(source));
            } else if n.kind == "asset" {
                let id = resource
                    .strip_prefix("asset:")
                    .ok_or("Invalid asset identity")?;
                let asset = self
                    .assets
                    .get(id)
                    .ok_or_else(|| format!("Missing media asset {id}"))?;
                let video = asset.mime.starts_with("video/");
                let image_key = format!("{}:{}", asset.mime, asset.fingerprint);
                if !video {
                    if let Some(source) = self
                        .images
                        .borrow()
                        .get(&image_key)
                        .and_then(std::rc::Weak::upgrade)
                    {
                        out.files.push(asset.file.clone());
                        out.sources.insert(resource.clone(), source);
                        continue;
                    }
                }
                let config = if video {
                    serde_json::json!({"is_local_file":true,"local_file":asset.file.path,"looping":n.looping.unwrap_or(true),"restart_on_activate":false,"close_when_inactive":false,"clear_on_media_end":false,"hw_decode":false})
                } else {
                    serde_json::json!({"file":asset.file.path})
                };
                let settings = ffi::obs_data_create_from_json(
                    CString::new(config.to_string()).unwrap().as_ptr(),
                );
                let source = ffi::obs_source_create_private(
                    if video {
                        c"ffmpeg_source".as_ptr()
                    } else {
                        c"image_source".as_ptr()
                    },
                    c"Set media resource".as_ptr(),
                    settings,
                );
                ffi::obs_data_release(settings);
                if source.is_null() {
                    return Err("Embedded media creation failed".into());
                }
                let source = Source(source);
                ffi::obs_source_set_audio_mixers(source.0, 0);
                ffi::obs_source_set_muted(source.0, true);
                if video {
                    ffi::obs_source_inc_active(source.0);
                    ffi::obs_source_inc_showing(source.0);
                    ffi::obs_source_media_play_pause(source.0, true);
                    let position = n.playback.as_ref().map_or(0., |p| p.position_ms);
                    ffi::obs_source_media_set_time(source.0, position as i64);
                    out.media.push(MediaBinding {
                        source: source.0,
                        playing: n.playback.as_ref().map_or(true, |p| p.playing),
                        position_ms: position,
                    });
                }
                out.files.push(asset.file.clone());
                let source = std::rc::Rc::new(source);
                if !video {
                    let mut images = self.images.borrow_mut();
                    images.retain(|_, s| s.strong_count() > 0);
                    images.insert(image_key, std::rc::Rc::downgrade(&source));
                }
                out.sources.insert(resource.clone(), source);
            }
        }
        Ok(out)
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        self.assets.clear();
        let _ = std::fs::remove_dir(&self.directory);
    }
}
pub struct ShaderBinding {
    pub source: *mut ffi::obs_source_t,
    pub intensity: f32,
    pub scale: f32,
    pub opacity: f32,
    pub base_ms: f64,
    pub running: bool,
}
pub struct MediaBinding {
    pub source: *mut ffi::obs_source_t,
    pub playing: bool,
    pub position_ms: f64,
}
extern "C" {
    fn producer_set_v2_surface_warm(source: *mut ffi::obs_source_t) -> bool;
}
pub struct Prepared {
    pub sources: HashMap<String, std::rc::Rc<Source>>,
    files: Vec<Arc<FileLease>>,
    pub shaders: Vec<ShaderBinding>,
    pub scenes3d: HashMap<String, std::rc::Rc<super::scene3d::Lease>>,
    pub media: Vec<MediaBinding>,
}
impl Prepared {
    pub unsafe fn ready(&self) -> bool {
        self.scenes3d.values().all(|s| s.ready())
            && self
                .sources
                .values()
                .all(|s| producer_set_v2_surface_warm(s.0))
    }
}
impl Prepared {
    pub fn publish3d(
        &self,
        specs: &HashMap<String, super::scene3d::Spec>,
        clock: Option<&super::contract::Clock>,
    ) {
        for (key, lease) in &self.scenes3d {
            if let Some(spec) = specs.get(key) {
                lease.publish(spec, clock);
            }
        }
    }
    pub fn hide_unshared3d(&self, next: &Self) {
        for lease in self.scenes3d.values() {
            if !next
                .scenes3d
                .values()
                .any(|n| std::rc::Rc::ptr_eq(n, lease))
            {
                lease.hide();
            }
        }
    }
    pub fn pause3d(&self, paused: bool) {
        for lease in self.scenes3d.values() {
            lease.pause(paused);
        }
    }
    pub fn presented3d(&self) -> bool {
        self.scenes3d.values().all(|s| s.ready())
    }
    pub fn error3d(&self) -> Option<String> {
        self.scenes3d.values().find_map(|s| s.error())
    }
}
impl Drop for Prepared {
    fn drop(&mut self) {
        unsafe {
            for media in &self.media {
                ffi::obs_source_dec_showing(media.source);
                ffi::obs_source_dec_active(media.source);
            }
        }
    }
}
unsafe fn shader_source(spec: &Shader, w: f32, h: f32) -> Result<Source, String> {
    let data = serde_json::json!({"width":w,"height":h,"effect":spec.effect,"speed":spec.speed,"intensity":spec.intensity,"scale":spec.scale,"opacity":spec.opacity,"radius":spec.radius,"quality":spec.quality,"clock":spec.clock,"colorA":spec.colors[0],"colorB":spec.colors[1],"colorC":spec.colors[2]});
    let kernel = super::super::shaders::native_effect();
    let source = ffi::producer_shader_create(
        CString::new(data.to_string()).unwrap().as_ptr(),
        CString::new(kernel).unwrap().as_ptr(),
    );
    if source.is_null() {
        return Err("Native material allocation failed".into());
    }
    let source = Source(source);
    if ffi::obs_source_get_width(source.0) == 0 || ffi::obs_source_get_height(source.0) == 0 {
        return Err("Native material compilation failed".into());
    }
    Ok(source)
}
