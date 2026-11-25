//! Production Boomin identity, native workspace preference, and stable on-device studio documents.
use crate::boomin::{self, DEFAULT_BOOMIN_API_ROOT as API};
use anyhow::{anyhow, ensure, Context, Result};
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use uuid::Uuid;

/// Panels contributed by the built-in Boomin integration to the studio's dock picker.
pub const STUDIO_PANELS: &[crate::workspace::PanelId] = &[crate::workspace::PanelId::Network];

const VAULT: &str = "ai.boomin.producer.native.account";
#[derive(Clone, Serialize, Deserialize)]
pub struct Login {
    key: String,
    production: bool,
    pub brand: String,
}
#[derive(Default, Serialize, Deserialize)]
struct Choice {
    login: Option<Login>,
    #[serde(default)]
    local: bool,
}
#[derive(Clone, Deserialize)]
pub struct RemoteRoom {
    pub id: Uuid,
    pub title: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub is_default: bool,
    status: Option<String>,
    archived_at: Option<Value>,
    deleted_at: Option<Value>,
}
pub struct Account {
    pub login: Login,
    pub name: String,
    pub email: String,
    pub method: String,
    pub two_factor: Option<bool>,
    pub brands: Vec<(String, String)>,
    pub rooms: Vec<RemoteRoom>,
    pub avatar: Option<image::RgbaImage>,
}
pub enum Action {
    Restore,
    UseProducerLogin,
    RequestCode(String),
    Verify(String, String),
    Switch(Login, String),
    SignOut,
    Create(Login, String, String),
}
pub enum Outcome {
    Local,
    CodeSent,
    Authenticated(Account),
    Pick(Login, Vec<(String, String)>),
    Created(Account, Uuid),
}
fn save_json(path: &Path, data: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("Missing workspace directory")?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(tmp.as_file_mut(), data)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    Ok(())
}
fn state(base: &Path) -> PathBuf {
    base.join("boomin-session.json")
}
fn production_login() -> Result<Option<Login>> {
    let Some(home) = std::env::var_os("HOME") else {
        return Ok(None);
    };
    let db = PathBuf::from(home).join("Library/Application Support/ai.boomin.producer/producer.db");
    if !db.is_file() {
        return Ok(None);
    }
    let out=Command::new("/usr/bin/sqlite3").args(["-readonly","-json"]).arg(db)
        .arg("SELECT id,brand_slug FROM endpoints WHERE kind='connected' AND base_url='https://api.boomin.ai/v1/app/producer' AND length(brand_slug)>0 ORDER BY created_at,id LIMIT 1").output()?;
    ensure!(
        out.status.success(),
        "Could not read Producer's saved workspace"
    );
    if out.stdout.is_empty() {
        return Ok(None);
    }
    let rows: Vec<Value> = serde_json::from_slice(&out.stdout)?;
    Ok(rows.first().and_then(|v| {
        Some(Login {
            key: v["id"].as_str()?.into(),
            production: true,
            brand: v["brand_slug"].as_str()?.into(),
        })
    }))
}
fn choice(base: &Path) -> Result<Choice> {
    match fs::read(state(base)) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Choice {
            login: production_login()?,
            local: false,
        }),
        Err(e) => Err(e.into()),
    }
}
impl Login {
    fn token(&self) -> Result<String> {
        let service = if self.production {
            "ai.boomin.producer"
        } else {
            VAULT
        };
        let bytes = get_generic_password(service, &self.key)
            .context("Allow Producer to read its Boomin sign-in in Keychain, or sign in again")?;
        Ok(String::from_utf8(bytes)?)
    }
}
pub fn room_token(base: &Path, brand: &str) -> Result<String> {
    let login = choice(base)?.login.context("Sign in to Boomin")?;
    ensure!(login.brand == brand, "Select this room's workspace");
    login.token()
}
pub(crate) fn http() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?)
}
async fn register_room(
    client: &reqwest::Client,
    brand: &str,
    token: &str,
    title: &str,
    reference: &str,
) -> Result<Uuid> {
    let response: Value = client
        .post(format!("{API}/v1/app/live/rooms"))
        .query(&[("brandSlug", brand)])
        .bearer_auth(token)
        .json(&json!({"title":title,"external_ref":reference}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    serde_json::from_value(response["room"]["id"].clone()).context("Boomin returned no room ID")
}

#[cfg(debug_assertions)]
pub fn link_dev_room(base: &Path, root: &Path, local_room: &str, title: &str) -> Result<()> {
    use sha2::{Digest, Sha256};
    let binding = root.join("boomin/room-binding.json");
    if binding.is_file() {
        return Ok(());
    }
    let login = choice(base)?.login.context("Sign in to Boomin first")?;
    ensure!(!login.brand.is_empty(), "Choose a Boomin workspace first");
    let token = login.token()?;
    // A stable reference lets a retry recover the same private dev room even
    // if registration succeeds before the local binding can be written.
    let mut digest = Sha256::new();
    digest.update(root.canonicalize()?.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(local_room.as_bytes());
    let reference = format!("producer-native-dev:{:x}", digest.finalize());
    let title = format!("{} · Native Dev", title.trim().chars().take(63).collect::<String>());
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let room_id = rt.block_on(async {
        register_room(&http()?, &login.brand, &token, &title, &reference).await
    })?;
    save_json(&binding, &json!({
        "roomId":room_id,"localRoom":local_room,"brandSlug":login.brand,
        "domain":"producer.dev","nativeAccount":true
    }))
}
async fn account(
    client: &reqwest::Client,
    login: Login,
    token: &str,
    brands: Vec<(String, String)>,
) -> Result<Account> {
    ensure!(
        brands.iter().any(|(s, _)| s == &login.brand),
        "This account no longer has access to the selected workspace"
    );
    let get = |path: &str| {
        client
            .get(format!("{API}{path}"))
            .query(&[("brandSlug", &login.brand)])
            .bearer_auth(token)
    };
    let fetch = |r: reqwest::RequestBuilder| async move {
        r.send().await?.error_for_status()?.json::<Value>().await
    };
    let (me, rooms) = tokio::try_join!(
        fetch(get("/v1/app/auth/me")),
        fetch(get("/v1/app/live/rooms"))
    )?;
    let user = &me["user"];
    let email = user["email"].as_str().unwrap_or_default().to_string();
    let name = user["name"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(&email)
        .to_string();
    ensure!(!name.is_empty(), "Boomin returned an incomplete profile");
    let mut rooms: Vec<RemoteRoom> =
        serde_json::from_value(rooms["rooms"].clone()).context("Invalid Boomin room list")?;
    rooms.retain(|r| {
        r.deleted_at.is_none()
            && r.archived_at.is_none()
            && !matches!(r.status.as_deref(), Some("archived" | "deleted" | "closed"))
    });
    rooms.sort_by_key(|r| !r.is_default);
    let method = ["auth_provider", "provider", "sign_in_method"]
        .into_iter()
        .find_map(|k| user[k].as_str())
        .unwrap_or("Email code")
        .into();
    let two_factor = ["two_factor_enabled", "twoFactorEnabled", "mfa_enabled"]
        .into_iter()
        .find_map(|k| user[k].as_bool())
        .or(me["two_factor_enabled"].as_bool());
    let photo = ["avatar_url", "avatarUrl", "image", "picture"]
        .into_iter()
        .find_map(|k| user[k].as_str().filter(|s| !s.is_empty()));
    let avatar = if let Some(photo) = photo {
        avatar(photo).await.ok()
    } else {
        None
    };
    Ok(Account {
        login,
        name,
        email,
        method,
        two_factor,
        rooms,
        brands,
        avatar,
    })
}
pub(crate) async fn avatar(raw: &str) -> Result<image::RgbaImage> {
    let url = url::Url::parse(API)?.join(raw)?;
    ensure!(url.scheme() == "https", "Invalid avatar URL");
    let mut res = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(8))
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?;
    let mut data = Vec::new();
    while let Some(chunk) = res.chunk().await? {
        ensure!(
            data.len() + chunk.len() <= 8 * 1024 * 1024,
            "Avatar exceeds image budget"
        );
        data.extend(chunk);
    }
    let reader = image::ImageReader::new(std::io::Cursor::new(data)).with_guessed_format()?;
    let img = reader
        .decode()?
        .resize_to_fill(96, 96, image::imageops::FilterType::Triangle)
        .into_rgba8();
    Ok(img)
}
async fn resolve(
    base: &Path,
    login: Login,
    token: &str,
    selected: Option<String>,
) -> Result<Outcome> {
    let brands = boomin::list_brands(API, token).await?;
    ensure!(
        !brands.is_empty(),
        "Create a brand on boomin.ai to open its rooms"
    );
    let mut login = login;
    if let Some(slug) = selected {
        login.brand = slug;
    }
    if !brands.iter().any(|b| b.0 == login.brand) {
        if brands.len() == 1 {
            login.brand = brands[0].0.clone();
        } else {
            return Ok(Outcome::Pick(login, brands));
        }
    }
    let a = account(&http()?, login.clone(), token, brands).await?;
    save_json(
        &state(base),
        &Choice {
            login: Some(login),
            local: false,
        },
    )?;
    Ok(Outcome::Authenticated(a))
}
pub fn run(base: &Path, action: Action) -> Result<Outcome> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    rt.block_on(async {
        match action {
            Action::Restore => {
                let Some(l) = choice(base)?.login else {
                    return Ok(Outcome::Local);
                };
                let t = l.token()?;
                resolve(base, l, &t, None).await
            }
            Action::UseProducerLogin => {
                let login = production_login()?.context("No saved Producer sign-in. Sign in with your email.")?;
                let token = login.token()?;
                resolve(base, login, &token, None).await
            }
            Action::RequestCode(email) => {
                boomin::request_otp(API, email.trim()).await?;
                Ok(Outcome::CodeSent)
            }
            Action::Verify(email, code) => {
                let t = boomin::verify_otp(API, email.trim(), code.trim()).await?;
                let login = Login {
                    key: Uuid::new_v4().to_string(),
                    production: false,
                    brand: String::new(),
                };
                set_generic_password(VAULT, &login.key, t.as_bytes())?;
                let old = choice(base)?.login;
                let result = resolve(base, login.clone(), &t, None).await;
                if matches!(&result, Ok(Outcome::Pick(..))) {
                    save_json(
                        &state(base),
                        &Choice {
                            login: Some(login.clone()),
                            local: false,
                        },
                    )?;
                }
                if result.is_err() {
                    let _ = delete_generic_password(VAULT, &login.key);
                } else if let Some(prev) = old.filter(|p| !p.production) {
                    let _ = delete_generic_password(VAULT, &prev.key);
                }
                result
            }
            Action::Switch(l, slug) => {
                let t = l.token()?;
                resolve(base, l, &t, Some(slug)).await
            }
            Action::SignOut => {
                let old = choice(base)?.login;
                save_json(&state(base), &Choice::default())?;
                if let Some(l) = old.filter(|p| !p.production) {
                    delete_generic_password(VAULT, &l.key)?;
                }
                Ok(Outcome::Local)
            }
            Action::Create(l, title, reference) => {
                let t = l.token()?;
                let client = http()?;
                let id = register_room(&client, &l.brand, &t, &title, &reference).await?;
                let brands = boomin::list_brands(API, &t).await?;
                Ok(Outcome::Created(account(&client, l, &t, brands).await?, id))
            }
        }
    })
}
pub fn room_path(base: &Path, brand: &str, id: Uuid) -> PathBuf {
    use sha2::{Digest, Sha256};
    base.join("boomin-workspaces")
        .join(format!("{:x}", Sha256::digest(brand.as_bytes())))
        .join(id.to_string())
}
pub fn prepare_room(
    base: &Path, brand: &str, room: &RemoteRoom, starter: Option<crate::studio_presets::Starter>,
) -> Result<PathBuf> {
    let path = room_path(base, brand, room.id);
    if path.join("room.json").is_file() {
        return Ok(path);
    }
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)?;
    let tmp = tempfile::Builder::new()
        .prefix(".preparing-")
        .tempdir_in(parent)?;
    let mut project = crate::model::RoomProject::demo();
    project.room = room.id.to_string();
    // Cloud room IDs are UUIDs. Native document identifiers must start with a letter.
    project.production.id = format!("room-{}", room.id);
    project.production.title = room
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("Studio")
        .into();
    if let Some(starter) = starter {
        starter.apply(&mut project)?;
    }
    project.compile()?;
    save_json(&tmp.path().join("room.json"), &project)?;
    save_json(
        &tmp.path().join("boomin/room-binding.json"),
        &json!({"roomId":room.id,"localRoom":room.id,"brandSlug":brand,"domain":"producer.dev","nativeAccount":true}),
    )?;
    if let Err(e) = fs::rename(tmp.path(), &path) {
        if !path.join("room.json").is_file() {
            return Err(anyhow!(e));
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reopening_and_signout_preserve_local_room_edits() {
        let root = tempfile::tempdir().unwrap();
        let room:RemoteRoom=serde_json::from_value(json!({"id":"71111111-2222-4333-8444-555555555555","title":"Main Stage","is_default":true})).unwrap();
        let first = prepare_room(root.path(), "brand-a", &room, Some(crate::studio_presets::Starter::Podcast)).unwrap();
        let mut project: crate::model::RoomProject =
            serde_json::from_slice(&fs::read(first.join("room.json")).unwrap()).unwrap();
        assert_eq!(project.room, room.id.to_string());
        assert_eq!(project.production.id, format!("room-{}", room.id));
        assert_eq!(project.mounted_set.as_deref(), Some("podcast-studio"));
        project.production.title = "My local edit".into();
        save_json(&first.join("room.json"), &project).unwrap();
        assert_eq!(first, prepare_room(root.path(), "brand-a", &room, None).unwrap());
        assert_ne!(first, room_path(root.path(), "brand-b", room.id));
        let v: Value = serde_json::from_slice(&fs::read(first.join("room.json")).unwrap()).unwrap();
        assert_eq!(v["production"]["title"], "My local edit");
        save_json(&state(root.path()), &Choice::default()).unwrap();
        assert!(matches!(
            run(root.path(), Action::Restore).unwrap(),
            Outcome::Local
        ));
    }
    #[test]
    #[ignore = "uses the signed-in production account and the macOS Keychain, read-only on Boomin"]
    fn restore_real_profile_twice() {
        let root = tempfile::tempdir().unwrap();
        let mut first = None;
        for _ in 0..2 {
            let Outcome::Authenticated(account) = run(root.path(), Action::Restore).unwrap() else {
                panic!("Expected an existing Boomin workspace")
            };
            assert!(account.avatar.is_some(), "Profile photo unavailable");
            assert!(!account.rooms.is_empty());
            let ids: Vec<_> = account.rooms.iter().map(|r| r.id).collect();
            if let Some(previous) = first.as_ref() {
                assert_eq!(previous, &ids)
            }
            eprintln!(
                "Verified a Boomin profile photo and {} room cards",
                ids.len()
            );
            first = Some(ids);
        }
    }
}
