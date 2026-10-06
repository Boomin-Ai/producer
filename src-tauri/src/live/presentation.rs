//! Private, read-only set output. Packages supply resolved visual data, never
//! URLs, browser settings, native handles, audio policy or execution authority.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Framing {
    pub mode: String,
    pub x: f64,
    pub y: f64,
}
impl Framing {
    fn validate(&self) -> Result<(), String> {
        if !["fill", "fit"].contains(&self.mode.as_str())
            || ![self.x, self.y]
                .iter()
                .all(|v| v.is_finite() && *v >= 0. && *v <= 1.)
        {
            Err("Invalid slot framing".into())
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, rename = "slotId", skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(default, rename = "slotLabel", skip_serializing_if = "Option::is_none")]
    pub slot_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<Framing>,
    pub styles: HashMap<String, Value>,
    pub children: Vec<Node>,
    #[serde(
        default,
        rename = "motionClass",
        skip_serializing_if = "Option::is_none"
    )]
    pub motion_class: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Projection {
    pub width: u32,
    pub height: u32,
    pub revision: u64,
    pub root: Node,
    pub css: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub generation: u64,
    pub lease: String,
    pub projection: Projection,
    pub bindings: HashMap<String, String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "slotId")]
    pub slot_id: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    #[serde(default)]
    pub appearance: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub framing: Option<Framing>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    pub revision: u64,
    pub width: u32,
    pub height: u32,
    pub slots: Vec<Placement>,
    pub surface: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub generation: u64,
    pub lease: Option<String>,
    pub revision: u64,
}

pub fn validate(request: &Request) -> Result<(), String> {
    if request.lease.len() != 36 || uuid::Uuid::parse_str(&request.lease).is_err() {
        return Err("Invalid set lease".into());
    }
    let p = &request.projection;
    if !(320..=3840).contains(&p.width)
        || !(320..=3840).contains(&p.height)
        || p.css.len() > 65536
        || request.bindings.len() > 8
    {
        return Err("Set output exceeds its budget".into());
    }
    let css = p.css.to_ascii_lowercase();
    if ["url(", "@import", "@font", "expression(", "<", ">", "\\"]
        .iter()
        .any(|s| css.contains(s))
    {
        return Err("Unsafe output CSS".into());
    }
    let allowed = [
        "position",
        "inset",
        "left",
        "top",
        "right",
        "bottom",
        "width",
        "height",
        "display",
        "gap",
        "padding",
        "background",
        "color",
        "border",
        "borderRadius",
        "boxShadow",
        "fontSize",
        "fontWeight",
        "letterSpacing",
        "textAlign",
        "lineHeight",
        "alignItems",
        "justifyContent",
        "gridTemplateColumns",
        "opacity",
        "overflow",
        "transform",
        "minHeight",
        "maxWidth",
    ];
    fn visit(
        n: &Node,
        allowed: &[&str],
        count: &mut usize,
        ids: &mut std::collections::HashSet<String>,
        slots: &mut Vec<String>,
        ancestor_effect: bool,
    ) -> Result<bool, String> {
        *count += 1;
        if let Some(f) = &n.framing {
            f.validate()?;
        }
        if *count > 600
            || n.id.is_empty()
            || n.id.len() > 1024
            || !ids.insert(n.id.clone())
            || !["box", "text", "slot"].contains(&n.r#type.as_str())
            || n.children.len() > 128
            || n.text.as_ref().is_some_and(|s| s.len() > 4096)
        {
            return Err("Invalid output tree".into());
        }
        for (key, v) in &n.styles {
            if !allowed.contains(&key.as_str()) {
                return Err("Unsupported output style".into());
            }
            if let Some(s) = v.as_str() {
                let lower = s.to_ascii_lowercase();
                if s.len() > 240
                    || s.chars().any(|c| c.is_control() || "\\/;{}<>@".contains(c))
                    || ["url(", "expression(", "image(", "image-set(", "paint("]
                        .iter()
                        .any(|s| lower.contains(s))
                {
                    return Err("Unsafe output style".into());
                }
            } else if !v
                .as_f64()
                .is_some_and(|x| x.is_finite() && x.abs() <= 10000.)
            {
                return Err("Invalid output style value".into());
            }
        }
        let effect = n.styles.contains_key("transform")
            || n.styles
                .get("opacity")
                .is_some_and(|v| v.as_f64() != Some(1.))
            || n.motion_class.is_some();
        let mut has_slot = n.r#type == "slot";
        if has_slot {
            let id = n.slot_id.as_ref().ok_or("Slot has no identity")?;
            if id.len() > 64 || ancestor_effect || effect {
                return Err(
                    "Animated or transformed video ancestors require a future compositor".into(),
                );
            }
            slots.push(id.clone());
            if slots.len() > 8 {
                return Err("Too many video placements".into());
            }
            if !n.children.is_empty() {
                return Err("Video slots cannot contain children".into());
            }
        }
        for child in &n.children {
            has_slot |= visit(child, allowed, count, ids, slots, ancestor_effect || effect)?;
        }
        Ok(has_slot)
    }
    let mut slots = Vec::new();
    visit(
        &p.root,
        &allowed,
        &mut 0,
        &mut Default::default(),
        &mut slots,
        false,
    )?;
    for (id, source) in &request.bindings {
        if !slots.contains(id) || source.len() > 128 || source.is_empty() {
            return Err("Binding does not belong to this layout".into());
        }
    }
    if serde_json::to_vec(p).map_err(|e| e.to_string())?.len() > 512 * 1024 {
        return Err("Output projection is too large".into());
    }
    Ok(())
}

struct BridgeState {
    receipts: HashMap<String, Receipt>,
}
pub struct Bridge {
    pub token: String,
    pub origin: String,
    projection: Projection,
    active: AtomicBool,
    state: Mutex<BridgeState>,
}
impl Bridge {
    pub fn start(projection: Projection) -> Result<Arc<Self>, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let bridge = Arc::new(Self {
            token: uuid::Uuid::new_v4().simple().to_string(),
            origin: format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port()),
            projection,
            active: AtomicBool::new(true),
            state: Mutex::new(BridgeState {
                receipts: HashMap::new(),
            }),
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || loop {
            let Some(bridge) = weak.upgrade() else { break };
            if !bridge.active.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    bridge.serve(stream);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    drop(bridge);
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        });
        Ok(bridge)
    }
    pub fn url(&self, surface: &str) -> String {
        format!("{}/{}/{}", self.origin, self.token, surface)
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::SeqCst);
    }
    pub fn wait(&self) -> Result<Vec<Placement>, String> {
        let start = Instant::now();
        loop {
            if !self.active.load(Ordering::SeqCst) {
                return Err("Set preparation was cancelled".into());
            }
            {
                let state = self.state.lock().unwrap();
                if let (Some(bg), Some(fg)) = (
                    state.receipts.get("background"),
                    state.receipts.get("foreground"),
                ) {
                    if bg.revision == self.projection.revision && fg.revision == bg.revision {
                        return Ok(fg.slots.clone());
                    }
                }
            }
            if start.elapsed() > Duration::from_secs(10) {
                return Err("Set graphics did not finish preparing; room output was kept".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn serve(&self, mut stream: TcpStream) {
        // macOS can inherit O_NONBLOCK from the listener. Chromium may connect
        // before sending its request; treating WouldBlock as EOF then produces
        // an intermittent ERR_EMPTY_RESPONSE instead of preparing the surface.
        if stream.set_nonblocking(false).is_err() {
            return;
        }
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
        let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
        let started = Instant::now();
        let mut bytes = Vec::new();
        let mut buf = [0u8; 4096];
        let header_end;
        loop {
            if started.elapsed() > Duration::from_secs(1) {
                return;
            }
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => bytes.extend_from_slice(&buf[..n]),
            };
            if bytes.len() > 8192 {
                return;
            }
            if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = i + 4;
                break;
            }
        }
        let headers = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = headers.lines();
        let Some(first) = lines.next() else { return };
        let parts: Vec<_> = first.split_whitespace().collect();
        if parts.len() != 3 {
            return;
        }
        #[cfg(debug_assertions)]
        eprintln!(
            "[set-bridge] revision={} request={}",
            self.projection.revision, first
        );
        let method = parts[0];
        let path = parts[1];
        let mut host = "";
        let mut origin = None;
        let mut length = 0;
        let mut invalid = false;
        for line in lines {
            if let Some((key, value)) = line.split_once(':') {
                let value = value.trim();
                match key.to_ascii_lowercase().as_str() {
                    "host" => host = value,
                    "origin" => origin = Some(value),
                    "content-length" => length = value.parse().unwrap_or(usize::MAX),
                    "transfer-encoding" => invalid = true,
                    _ => {}
                }
            }
        }
        let prefix = format!("/{}/", self.token);
        let mut status = "404 Not Found";
        let mut body = String::new();
        let mut kind = "text/plain";
        if self.active.load(Ordering::SeqCst)
            && host == self.origin.trim_start_matches("http://")
            && origin.is_none_or(|o| o == self.origin)
            && !invalid
            && path.starts_with(&prefix)
        {
            match (method, &path[prefix.len()..]) {
                ("GET", surface @ ("background" | "foreground")) if length == 0 => {
                    status = "200 OK";
                    kind = "text/html";
                    body = self.page(surface);
                }
                ("POST", "ready") if origin == Some(self.origin.as_str()) && length <= 32768 => {
                    let mut data = bytes[header_end..].to_vec();
                    while data.len() < length {
                        if started.elapsed() > Duration::from_secs(1) {
                            return;
                        }
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => data.extend_from_slice(&buf[..n]),
                        }
                    }
                    if let Ok(receipt) = serde_json::from_slice::<Receipt>(&data[..length]) {
                        if receipt.revision == self.projection.revision
                            && receipt.width == self.projection.width
                            && receipt.height == self.projection.height
                            && ["background", "foreground"].contains(&receipt.surface.as_str())
                            && receipt.slots.len() <= 8
                        {
                            #[cfg(debug_assertions)]
                            eprintln!(
                                "[set-bridge] prepared {} revision={}",
                                receipt.surface, receipt.revision
                            );
                            self.state
                                .lock()
                                .unwrap()
                                .receipts
                                .insert(receipt.surface.clone(), receipt);
                            status = "204 No Content";
                        }
                    }
                }
                _ => {}
            }
        }
        let nonce = &self.token;
        let headers=format!("HTTP/1.1 {status}\r\nContent-Type: {kind}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nPermissions-Policy: camera=(), microphone=(), display-capture=()\r\nContent-Security-Policy: default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n\r\n",body.len());
        let _ = stream.write_all(headers.as_bytes());
        let _ = stream.write_all(body.as_bytes());
    }
    fn page(&self, surface: &str) -> String {
        let nonce = &self.token;
        let frame=format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\"><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:system-ui,sans-serif}}*{{box-sizing:border-box}}#canvas{{position:absolute;transform-origin:top left;overflow:hidden}}</style><style id=\"motion\"></style><div id=\"canvas\"></div><script nonce=\"{nonce}\">{}</script>",include_str!("../../../src/features/presentation/frame.js"));
        let frame = serde_json::to_string(&frame)
            .unwrap()
            .replace('<', "\\u003c");
        let projection = serde_json::to_string(&self.projection)
            .unwrap()
            .replace('<', "\\u003c");
        let bg = if surface == "background" {
            "#000"
        } else {
            "transparent"
        };
        format!("<!doctype html><style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:{bg}}}iframe{{width:100%;height:100%;border:0}}</style><iframe sandbox=\"allow-scripts\" allow=\"camera 'none'; microphone 'none'; display-capture 'none'\"></iframe><script nonce=\"{nonce}\">const f=document.querySelector('iframe');let port;addEventListener('message',e=>{{if(e.source!==f.contentWindow||e.data!=='presentation.ready'||port)return;const c=new MessageChannel();port=c.port1;port.onmessage=e=>{{if(e.data?.type==='prepared')fetch('ready',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{...e.data,surface:'{surface}',type:undefined}}),credentials:'omit'}});}};port.start();f.contentWindow.postMessage('presentation.connect','*',[c.port2]);port.postMessage({{type:'output',surface:'{surface}',projection:{projection}}});}});f.srcdoc={frame};</script>")
    }
}

// OBS's browser event loop advances during video_render. A prepared source is
// deliberately off output, so render its graphics into a private target until
// its geometry receipt arrives. Never warm it by adding it to the room scene.
#[cfg(have_engine)]
struct PreparationRender {
    scene: *mut super::ffi::obs_scene_t,
    target: *mut std::ffi::c_void,
    width: u32,
    height: u32,
}
#[cfg(have_engine)]
extern "C" fn prepare_render(data: *mut std::ffi::c_void, _: u32, _: u32) {
    unsafe {
        use super::ffi;
        let render = &mut *(data as *mut PreparationRender);
        if render.target.is_null() {
            render.target = ffi::gs_texrender_create(ffi::GS_RGBA, ffi::GS_ZS_NONE);
        }
        if render.target.is_null() {
            return;
        }
        ffi::gs_texrender_reset(render.target);
        if ffi::gs_texrender_begin(render.target, render.width, render.height) {
            ffi::gs_ortho(
                0.,
                render.width as f32,
                0.,
                render.height as f32,
                -100.,
                100.,
            );
            ffi::gs_blend_state_push();
            ffi::gs_blend_function(ffi::GS_BLEND_ONE, ffi::GS_BLEND_INVSRCALPHA);
            ffi::obs_source_video_render(ffi::obs_scene_get_source(render.scene));
            ffi::gs_blend_state_pop();
            ffi::gs_texrender_end(render.target);
        }
    }
}
#[cfg(have_engine)]
pub struct Composition {
    preparation_render: Option<Box<PreparationRender>>,
    pub request: Request,
    pub bridge: Arc<Bridge>,
    pub scene: *mut super::ffi::obs_scene_t,
    pub item: *mut super::ffi::obs_sceneitem_t,
    sources: Vec<*mut super::ffi::obs_source_t>,
    captures: HashMap<String, *mut super::ffi::obs_source_t>,
    showing: Vec<*mut super::ffi::obs_source_t>,
}
#[cfg(have_engine)]
impl Composition {
    pub unsafe fn build(
        request: Request,
        captures: HashMap<String, *mut super::ffi::obs_source_t>,
    ) -> Result<Self, String> {
        use super::ffi;
        use std::ffi::CString;
        let bridge = Bridge::start(request.projection.clone())?;
        let scene = ffi::obs_scene_create(
            CString::new(format!("Set {}", bridge.token))
                .unwrap()
                .as_ptr(),
        );
        if scene.is_null() {
            bridge.revoke();
            return Err("Set composition allocation failed".into());
        }
        let mut out = Self {
            preparation_render: None,
            request,
            bridge,
            scene,
            item: std::ptr::null_mut(),
            sources: Vec::new(),
            captures: HashMap::new(),
            showing: Vec::new(),
        };
        ffi::obs_source_set_audio_mixers(ffi::obs_scene_get_source(scene), 0);
        for (id, capture) in captures {
            out.captures.insert(id, ffi::obs_source_get_ref(capture));
        }
        let mut info: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return Err("Canvas is not running".into());
        }
        let info = info.assume_init();
        let base = (info.base_width as f32, info.base_height as f32);
        let settings = ffi::obs_data_create();
        for (key, value) in [
            ("width", info.base_width as i64),
            ("height", info.base_height as i64),
            ("color", 0xff000000),
        ] {
            ffi::obs_data_set_int(settings, CString::new(key).unwrap().as_ptr(), value);
        }
        let black = ffi::obs_source_create_private(
            CString::new("color_source_v3").unwrap().as_ptr(),
            CString::new("Set canvas").unwrap().as_ptr(),
            settings,
        );
        ffi::obs_data_release(settings);
        if black.is_null() {
            return Err("Set canvas creation failed".into());
        }
        out.sources.push(black);
        if ffi::obs_scene_add(scene, black).is_null() {
            return Err("Set canvas attachment failed".into());
        }
        let scale = (base.0 / out.request.projection.width as f32)
            .min(base.1 / out.request.projection.height as f32);
        let width = out.request.projection.width as f32 * scale;
        let height = out.request.projection.height as f32 * scale;
        for surface in ["background", "foreground"] {
            let settings = ffi::obs_data_create();
            ffi::obs_data_set_string(
                settings,
                CString::new("url").unwrap().as_ptr(),
                CString::new(out.bridge.url(surface)).unwrap().as_ptr(),
            );
            for (key, value) in [
                ("width", out.request.projection.width as i64),
                ("height", out.request.projection.height as i64),
                ("fps", 30),
                ("webpage_control_level", 0),
            ] {
                ffi::obs_data_set_int(settings, CString::new(key).unwrap().as_ptr(), value);
            }
            for (key, value) in [
                ("fps_custom", true),
                ("shutdown", false),
                ("restart_when_active", false),
                ("reroute_audio", true),
            ] {
                ffi::obs_data_set_bool(settings, CString::new(key).unwrap().as_ptr(), value);
            }
            let src = ffi::obs_source_create_private(
                CString::new("browser_source").unwrap().as_ptr(),
                CString::new(format!("Set {surface}")).unwrap().as_ptr(),
                settings,
            );
            ffi::obs_data_release(settings);
            if src.is_null() {
                return Err("This engine cannot render set graphics".into());
            }
            ffi::obs_source_set_audio_mixers(src, 0);
            ffi::obs_source_set_muted(src, true);
            out.sources.push(src);
            ffi::obs_source_inc_active(src);
            ffi::obs_source_inc_showing(src);
            out.showing.push(src);
            let item = ffi::obs_scene_add(scene, src);
            if item.is_null() {
                return Err("Set graphics attachment failed".into());
            }
            ffi::obs_sceneitem_set_pos(
                item,
                &ffi::vec2 {
                    x: (base.0 - width) / 2.,
                    y: (base.1 - height) / 2.,
                },
            );
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            ffi::obs_sceneitem_set_bounds(
                item,
                &ffi::vec2 {
                    x: width,
                    y: height,
                },
            );
        }
        let mut render = Box::new(PreparationRender {
            scene,
            target: std::ptr::null_mut(),
            width: info.base_width,
            height: info.base_height,
        });
        ffi::obs_add_main_render_callback(prepare_render, &mut *render as *mut _ as *mut _);
        out.preparation_render = Some(render);
        Ok(out)
    }
    unsafe fn stop_preparing(&mut self) {
        if let Some(mut render) = self.preparation_render.take() {
            super::ffi::obs_remove_main_render_callback(
                prepare_render,
                &mut *render as *mut _ as *mut _,
            );
            if !render.target.is_null() {
                super::ffi::obs_enter_graphics();
                super::ffi::gs_texrender_destroy(render.target);
                super::ffi::obs_leave_graphics();
            }
        }
    }
    pub unsafe fn dress(&mut self, placements: Vec<Placement>) -> Result<(), String> {
        self.stop_preparing();
        use super::ffi;
        use std::ffi::CString;
        let p = &self.request.projection;
        let mut seen = std::collections::HashSet::new();
        fn collect(n: &Node, out: &mut HashMap<String, String>) {
            if let Some(id) = &n.slot_id {
                out.insert(n.id.clone(), id.clone());
            }
            for c in &n.children {
                collect(c, out);
            }
        }
        let mut slots = HashMap::new();
        collect(&p.root, &mut slots);
        if placements.len() != slots.len() {
            return Err("Renderer did not prepare every slot".into());
        }
        for slot in &placements {
            if slots.get(&slot.node_id) != Some(&slot.slot_id)
                || !seen.insert(slot.node_id.clone())
                || ![slot.x, slot.y, slot.width, slot.height]
                    .iter()
                    .all(|v| v.is_finite())
                || slot.x < 0.
                || slot.y < 0.
                || slot.width <= 0.
                || slot.height <= 0.
                || slot.x + slot.width > p.width as f32 + 1.
                || slot.y + slot.height > p.height as f32 + 1.
            {
                return Err("Set slot geometry is invalid".into());
            }
            if let Some(f) = &slot.framing {
                f.validate()?;
            }
            if let Some(a) = &slot.appearance {
                super::filters::validate_appearance_patch(
                    a.as_object().ok_or("Invalid slot appearance")?,
                )?;
            }
        }
        let mut info: std::mem::MaybeUninit<ffi::obs_video_info> = std::mem::MaybeUninit::zeroed();
        if !ffi::obs_get_video_info(info.as_mut_ptr()) {
            return Err("Canvas stopped during preparation".into());
        }
        let info = info.assume_init();
        let scale = (info.base_width as f32 / p.width as f32)
            .min(info.base_height as f32 / p.height as f32);
        let offset = (
            (info.base_width as f32 - p.width as f32 * scale) / 2.,
            (info.base_height as f32 - p.height as f32 * scale) / 2.,
        );
        for (index, slot) in placements.iter().enumerate() {
            let Some(capture) = self.captures.get(&slot.slot_id) else {
                continue;
            };
            let proxy = ffi::producer_source_placement_create(*capture);
            if proxy.is_null() {
                return Err("Source cannot be used as a video placement".into());
            }
            self.sources.push(proxy);
            if let Some(f) = &slot.framing {
                if f.mode == "fill" {
                    let sw = ffi::obs_source_get_width(*capture) as f64;
                    let sh = ffi::obs_source_get_height(*capture) as f64;
                    if sw <= 0. || sh <= 0. {
                        return Err("Slot source has no dimensions".into());
                    }
                    let ratio = slot.width as f64 / slot.height as f64;
                    let (cw, ch) = if sw / sh > ratio {
                        (sh * ratio, sh)
                    } else {
                        (sw, sw / ratio)
                    };
                    let dx = (sw - cw).max(0.).floor() as i32;
                    let dy = (sh - ch).max(0.).floor() as i32;
                    let left = (dx as f64 * f.x).round() as i32;
                    let top = (dy as f64 * f.y).round() as i32;
                    let values = serde_json::json!({"relative":true,"left":left,"right":dx-left,"top":top,"bottom":dy-top});
                    let json = CString::new(values.to_string()).unwrap();
                    let data = ffi::obs_data_create_from_json(json.as_ptr());
                    let filter = ffi::obs_source_create_private(
                        CString::new("crop_filter").unwrap().as_ptr(),
                        CString::new("Set framing").unwrap().as_ptr(),
                        data,
                    );
                    ffi::obs_data_release(data);
                    if filter.is_null() {
                        return Err("Set crop filter is unavailable".into());
                    }
                    ffi::obs_source_filter_add(proxy, filter);
                    ffi::obs_source_release(filter);
                }
            }
            if let Some(appearance) = &slot.appearance {
                let filter = ffi::obs_source_create_private(
                    CString::new("producer_source_appearance").unwrap().as_ptr(),
                    CString::new("Set slot appearance").unwrap().as_ptr(),
                    std::ptr::null_mut(),
                );
                if filter.is_null() {
                    return Err("Source appearance is unavailable".into());
                }
                let mut values = appearance.clone();
                let obj = values.as_object_mut().unwrap();
                obj.insert("displayWidth".into(), Value::from(slot.width));
                obj.insert("displayHeight".into(), Value::from(slot.height));
                let json = CString::new(values.to_string()).unwrap();
                let data = ffi::obs_data_create_from_json(json.as_ptr());
                ffi::obs_source_update(filter, data);
                ffi::obs_data_release(data);
                ffi::obs_source_filter_add(proxy, filter);
                ffi::obs_source_release(filter);
            }
            let item = ffi::obs_scene_add(self.scene, proxy);
            if item.is_null() {
                return Err("Video placement attachment failed".into());
            }
            ffi::obs_sceneitem_set_pos(
                item,
                &ffi::vec2 {
                    x: offset.0 + slot.x * scale,
                    y: offset.1 + slot.y * scale,
                },
            );
            ffi::obs_sceneitem_set_bounds_type(item, ffi::OBS_BOUNDS_SCALE_INNER);
            ffi::obs_sceneitem_set_bounds(
                item,
                &ffi::vec2 {
                    x: slot.width * scale,
                    y: slot.height * scale,
                },
            );
            ffi::obs_sceneitem_set_order_position(item, index as i32 + 2);
        }
        Ok(())
    }
}
#[cfg(have_engine)]
impl Drop for Composition {
    fn drop(&mut self) {
        unsafe {
            self.stop_preparing();
            self.bridge.revoke();
            if !self.item.is_null() {
                super::ffi::obs_sceneitem_remove(self.item);
            }
            for source in &self.showing {
                super::ffi::obs_source_dec_showing(*source);
                super::ffi::obs_source_dec_active(*source);
            }
            super::ffi::obs_scene_release(self.scene);
            for source in &self.sources {
                super::ffi::obs_source_release(*source);
            }
            for source in self.captures.values() {
                super::ffi::obs_source_release(*source);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            generation: 1,
            lease: uuid::Uuid::new_v4().to_string(),
            bindings: HashMap::from([("host".into(), "camera".into())]),
            projection: Projection {
                width: 1280,
                height: 720,
                revision: 1,
                css: String::new(),
                root: Node {
                    id: "root".into(),
                    r#type: "box".into(),
                    text: None,
                    slot_id: None,
                    slot_label: None,
                    appearance: None,
                    framing: None,
                    styles: HashMap::new(),
                    motion_class: None,
                    children: vec![Node {
                        id: "host".into(),
                        r#type: "slot".into(),
                        slot_id: Some("host".into()),
                        slot_label: Some("Host".into()),
                        text: None,
                        appearance: None,
                        framing: None,
                        styles: HashMap::new(),
                        children: vec![],
                        motion_class: None,
                    }],
                },
            },
        }
    }
    #[test]
    fn bounds_bindings_and_resources_are_checked_before_native_allocation() {
        let base = request();
        validate(&base).unwrap();
        let mut r = base.clone();
        r.projection
            .root
            .children
            .push(r.projection.root.children[0].clone());
        assert!(validate(&r).is_err());
        let mut r = base.clone();
        r.bindings.insert("unknown".into(), "camera".into());
        assert!(validate(&r).is_err());
        let mut r = base.clone();
        r.projection
            .root
            .styles
            .insert("background".into(), Value::from("url(https://example.com)"));
        assert!(validate(&r).is_err());
        let mut r = base.clone();
        r.projection
            .root
            .styles
            .insert("transform".into(), Value::from("rotate(20deg)"));
        assert!(validate(&r).is_err());
        let mut r = base;
        r.projection.css = "@import 'https://example.com';".into();
        assert!(validate(&r).is_err());
    }
    fn http(
        bridge: &Bridge,
        method: &str,
        path: &str,
        host: &str,
        origin: Option<&str>,
        body: &str,
    ) -> String {
        let addr = bridge.origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let origin = origin
            .map(|o| format!("Origin: {o}\r\n"))
            .unwrap_or_default();
        stream.write_all(format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{origin}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }
    #[test]
    fn private_bridge_accepts_a_request_after_connect() {
        let bridge = Bridge::start(request().projection).unwrap();
        let host = bridge.origin.trim_start_matches("http://");
        let mut stream = TcpStream::connect(host).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        // Chromium preconnects before writing the navigation request. The
        // nonblocking listener must not make that pause look like EOF.
        std::thread::sleep(Duration::from_millis(100));
        stream
            .write_all(
                format!(
                    "GET /{}/background HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
                    bridge.token
                )
                .as_bytes(),
            )
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        bridge.revoke();
    }
    #[test]
    fn private_bridge_is_scoped_bounded_and_revocable() {
        let bridge = Bridge::start(request().projection).unwrap();
        let host = bridge.origin.trim_start_matches("http://");
        let route = format!("/{}/foreground", bridge.token);
        let page = http(&bridge, "GET", &route, host, None, "");
        assert!(page.starts_with("HTTP/1.1 200"));
        assert!(page.contains("sandbox=\"allow-scripts\""));
        assert!(page.contains("camera 'none'"));
        assert!(!page.contains("__TAURI_INTERNALS__"));
        assert!(http(&bridge, "GET", &route, "evil.example", None, "").starts_with("HTTP/1.1 404"));
        assert!(http(
            &bridge,
            "GET",
            &route,
            host,
            Some("https://evil.example"),
            ""
        )
        .starts_with("HTTP/1.1 404"));
        assert!(http(&bridge, "GET", "/foreground", host, None, "").starts_with("HTTP/1.1 404"));
        assert!(
            http(&bridge, "POST", &route, host, Some(&bridge.origin), "{}")
                .starts_with("HTTP/1.1 404")
        );
        let ready = format!("/{}/ready", bridge.token);
        for surface in ["background", "foreground"] {
            let data=serde_json::json!({"revision":1,"width":1280,"height":720,"surface":surface,"slots":[]}).to_string();
            assert!(
                http(&bridge, "POST", &ready, host, Some(&bridge.origin), &data)
                    .starts_with("HTTP/1.1 204")
            );
        }
        assert!(bridge.wait().unwrap().is_empty());
        bridge.revoke();
        assert!(bridge.wait().is_err());
    }
}
