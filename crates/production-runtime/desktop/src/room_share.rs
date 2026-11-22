//! A signed-in Boomin room binding is separate from the RTC transport selection.
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Binding {
    #[serde(default)]
    native_account: bool,
    room_id: String,
    brand_slug: String,
    domain: String,
    local_room: String,
}

#[derive(Clone, Copy)]
pub enum LinkKind {
    Guest,
    Audience,
    Room,
}

impl LinkKind {
    pub fn copied(self) -> &'static str {
        match self {
            Self::Guest => "Guest invitation copied",
            Self::Audience => "Audience link copied",
            Self::Room => "Room link copied",
        }
    }
}

fn account(root: &Path) -> Result<(Binding,String)> {
    let binding: Binding = serde_json::from_slice(
        &fs::read(root.join("boomin/room-binding.json"))
            .context("Connect this studio to a Boomin room first")?,
    )?;
    let local: Value = serde_json::from_slice(&fs::read(root.join("room.json"))?)?;
    ensure!(
        local["room"] == binding.local_room,
        "This binding belongs to another room"
    );
    ensure!(
        matches!(binding.domain.as_str(), "producer.dev" | "boomin.ai"),
        "Unknown room domain"
    );
    ensure!(
        binding.room_id.len() == 36
            && binding
                .room_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-'),
        "Invalid room binding"
    );
    let token = if binding.native_account {
        crate::boomin_account::room_token(&crate::workspace_root(), &binding.brand_slug)?
    } else {
        let account: Value = serde_json::from_slice(&fs::read(root.join("boomin/config.json"))?)?;
        ensure!(
            account["apiBase"] == "https://api.boomin.ai/v1/app",
            "Select a production Boomin workspace"
        );
        account["authToken"]
            .as_str()
            .context("Sign in to Boomin")?
            .to_owned()
    };
    Ok((binding,token))
}
fn api(binding: &Binding, token: &str, method: &str, resource: &str, body: Option<&Value>) -> Result<Value> {
        let mut url = url::Url::parse(&format!(
            "https://api.boomin.ai/v1/app/live/rooms/{}/{}",
            binding.room_id, resource
        ))?;
        url.query_pairs_mut()
            .append_pair("brandSlug", &binding.brand_slug);
        let reply = crate::rtc_signaling::request(method, url.as_str(), &token, body)?;
        if let Some(message) = reply.get("code").and_then(|_| reply["message"].as_str()) {
            anyhow::bail!("{}", message);
        }
        Ok::<Value, anyhow::Error>(reply)
}
pub fn link(root: &Path, kind: LinkKind) -> Result<String> {
    let (binding,token) = account(root)?;
    let call = |method, resource: &str, body: Option<&Value>| api(&binding,&token,method,resource,body);
    let room = call("GET", "share-links", None)?;
    ensure!(
        room["room_id"] == binding.room_id && room["brand_slug"] == binding.brand_slug,
        "Workspace or room has changed"
    );
    let slug = room["room_slug"]
        .as_str()
        .context("Room has no share address")?;
    let mut url = url::Url::parse(&format!("https://{}", binding.domain))?;
    if matches!(kind, LinkKind::Guest) {
        let invite = call("POST", "guests", Some(&json!({"display_name":"Guest"})))?;
        let target = url::Url::parse(
            invite["invite_url"]
                .as_str()
                .context("Guest invitation unavailable")?,
        )?;
        let code = target
            .path()
            .strip_prefix("/connect/guest/")
            .context("Invalid invitation")?;
        ensure!(
            code.starts_with("gi_")
                && code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)),
            "Invalid invitation"
        );
        url.path_segments_mut()
            .unwrap()
            .extend([binding.brand_slug.as_str(), "guest", slug, code]);
    } else {
        let section = if matches!(kind, LinkKind::Audience) {
            "audience"
        } else {
            "room"
        };
        url.path_segments_mut()
            .unwrap()
            .extend([binding.brand_slug.as_str(), section, slug]);
    }
    Ok(url.to_string())
}

pub fn audience_access(root: &Path, enabled: bool) -> Result<()> {
    let (binding,token) = account(root)?;
    let session = api(&binding,&token,"POST","channel-ticket",Some(&json!({})))?;
    ensure!(session["room_id"] == binding.room_id && session["role"] == "host", "Host access required");
    let path = session["signaling_url"].as_str().context("Room control unavailable")?;
    let url = url::Url::parse("wss://api.boomin.ai")?.join(path)?;
    ensure!(url.origin().ascii_serialization()=="wss://api.boomin.ai" && url.path()=="/v1/app/live/rooms/channel","Invalid room control address");
    let project: crate::model::RoomProject = serde_json::from_slice(&fs::read(root.join("room.json"))?)?;
    let scenes: Vec<_> = project.room_scenes.iter().map(|(id,s)| json!({"id":id,"name":s.name})).collect();
    let publish=json!({"type":"scene.publish","command_protocol":2,"request_id":uuid::Uuid::new_v4().to_string(),"scenes":scenes,"active_scene_id":project.active_scene});
    extern "C" {fn nr_audience_access(url:*const std::ffi::c_char, publish:*const std::ffi::c_char, enabled:bool)->bool;}
    let address=std::ffi::CString::new(url.as_str())?;
    let message=std::ffi::CString::new(publish.to_string())?;
    ensure!(unsafe{nr_audience_access(address.as_ptr(),message.as_ptr(),enabled)},"Audience access was not confirmed by the room host service");
    let marker=root.join("boomin/audience-open");
    if enabled {fs::write(marker,b"open")?;} else if marker.exists(){fs::remove_file(marker)?;}
    Ok(())
}

#[derive(Clone)]
pub struct WaitingGuest { pub id: uuid::Uuid, pub name: String }

pub fn admit(root: &Path, id: uuid::Uuid) -> Result<()> {
    let (binding,token)=account(root)?;
    let roster=api(&binding,&token,"GET","guests",None)?;
    let target=id.to_string();
    ensure!(roster["guests"].as_array().into_iter().flatten().any(|g|
        g["id"]==target && g["state"]=="waiting"),"Guest is no longer waiting in this room");
    let run=api(&binding,&token,"GET","rtc-control",None)?;
    let run=&run["rtc"];
    ensure!(run["state"]=="active","Start the room’s hosted RTC session before admitting a guest");
    let expected=json!({"run_id":run["run_id"],"control_revision":run["control_revision"],"host_lease_epoch":run["host_lease_epoch"]});
    let mut url=url::Url::parse(&format!("https://api.boomin.ai/v1/app/live/guests/{id}/admit"))?;
    url.query_pairs_mut().append_pair("brandSlug",&binding.brand_slug);
    let reply=crate::rtc_signaling::request("POST",url.as_str(),&token,Some(&json!({"rtc":{"request_id":uuid::Uuid::new_v4().to_string(),"expected":expected}})))?;
    ensure!(reply["guest"]["id"]==target && reply["guest"]["status"]=="accepted","{}",reply["message"].as_str().unwrap_or("Guest admission was not confirmed"));
    Ok(())
}

pub fn maintain_presence(handle: &std::sync::Arc<crate::engine::Handle>) {
    let root=handle.root.clone();
    if !root.join("boomin/room-binding.json").exists(){return;}
    let handle=handle.clone();
    std::thread::spawn(move || {
        while !handle.closed.load(std::sync::atomic::Ordering::Acquire) {
            let result=account(&root).and_then(|(binding,token)|api(&binding,&token,"GET","guests",None));
            if let Ok(roster)=result {
                *handle.waiting_guests.lock().unwrap()=waiting_guests(&roster);
            }
            for _ in 0..3 {if handle.closed.load(std::sync::atomic::Ordering::Acquire){return;} std::thread::sleep(std::time::Duration::from_secs(1));}
        }
    });
}

fn waiting_guests(roster: &Value) -> Vec<WaitingGuest> {
    roster["guests"].as_array().into_iter().flatten()
                    .filter(|g|g["state"]=="waiting")
                    .filter_map(|g|Some(WaitingGuest{id:g["id"].as_str()?.parse().ok()?,name:g["display_name"].as_str().unwrap_or("Guest").to_owned()})).collect()
}

#[test]
fn shows_waiting_seats_from_the_host_roster() {
    let id=uuid::Uuid::new_v4();
    let guests=waiting_guests(&json!({"guests":[
        {"id":id.to_string(),"state":"waiting","display_name":"Studio guest"},
        {"id":uuid::Uuid::new_v4().to_string(),"state":"invited"},
        {"id":uuid::Uuid::new_v4().to_string(),"state":"connected"}
    ]}));
    assert_eq!(guests.len(),1);
    assert_eq!(guests[0].id,id);
    assert_eq!(guests[0].name,"Studio guest");
}
