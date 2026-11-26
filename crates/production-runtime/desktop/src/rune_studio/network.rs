use super::*;
use anyhow::{ensure, Context, Result};
use serde_json::Value;
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Default)]
pub(super) struct Network {
    scope: Option<(String, String)>,
    tab: usize,
    studio_requests_selected: bool,
    synced: bool,
    query: TextEdit,
    data: Directory,
    found: Vec<Value>,
    searched: String,
    notice: String,
    sync_error: String,
    next: Option<Instant>,
    refresh: Option<mpsc::Receiver<Result<Directory>>>,
    action: Option<mpsc::Receiver<Result<Outcome>>>,
    logos: BTreeMap<String, Option<rune::Pixels>>,
    logo_updates: Option<mpsc::Receiver<(String, Option<image::RgbaImage>)>>,
}

#[derive(Default)]
struct Directory {
    connections: Vec<Value>,
    incoming: Vec<Value>,
    outgoing: Vec<Value>,
    rooms: Vec<Value>,
    studio_requests: Option<Vec<Value>>,
    requires_membership: bool,
    bound: Option<Uuid>,
}
enum Outcome {
    Search(String, Vec<Value>),
    Entry(String),
    Changed(String),
    Visibility(Uuid, String),
}
#[derive(Clone)]
enum Task {
    Search(String),
    Invite(Uuid),
    Respond(Uuid, &'static str),
    RequestStudio(Uuid),
    RespondStudio(Uuid, &'static str),
    JoinStudio(Uuid),
    Visibility(Uuid, &'static str),
    Join,
}

struct Api {
    bound: Option<Uuid>,
    client: reqwest::Client,
    token: String,
    brand: String,
}
impl Api {
    async fn call(&self, path: &str, query: &[(&str, &str)], body: Option<Value>) -> Result<Value> {
        let url = format!(
            "{}/v1/app/network/{path}",
            crate::boomin::DEFAULT_BOOMIN_API_ROOT
        );
        let request = match body {
            Some(v) => self.client.post(url).json(&v),
            None => self.client.get(url),
        };
        let response = request
            .query(&[("brandSlug", &self.brand)])
            .query(query)
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = response.status();
        let data: Value = response.json().await?;
        if path == "rooms/live"
            && data["code"] == "network_membership_required"
            && status.as_u16() == 409
        {
            return Ok(json!({"rooms":[],"requires_membership":true}));
        }
        ensure!(
            status.is_success(),
            "{}",
            data["error"]["message"]
                .as_str()
                .or(data["message"].as_str())
                .unwrap_or("Boomin could not complete this request")
        );
        Ok(data)
    }
    async fn rows(&self, path: &str, params: &[(&str, &str)], key: &str) -> Result<Vec<Value>> {
        self.call(path, params, None).await?[key]
            .as_array()
            .cloned()
            .context("Unexpected network response")
    }
    async fn refresh(&self) -> Result<Directory> {
        let (directory, studio_requests) = tokio::join!(
            async {
                tokio::try_join!(
                    self.rows("invitations", &[], "invitations"),
                    self.rows("invitations", &[("direction", "outbox")], "invitations"),
                    self.rows("connections", &[], "connections"),
                    self.call("rooms/live", &[("limit", "50")], None)
                )
            },
            self.rows("studio-requests", &[], "requests")
        );
        let (incoming, outgoing, connections, rooms) = directory?;
        Ok(Directory {
            incoming,
            outgoing,
            connections,
            rooms: rooms["rooms"]
                .as_array()
                .cloned()
                .context("Invalid open-studio list")?,
            requires_membership: rooms["requires_membership"] == true,
            bound: self.bound,
            studio_requests: studio_requests.ok(),
        })
    }
    async fn run(&self, task: Task) -> Result<Outcome> {
        match task {
            Task::Search(term) => {
                let found = if let Some(slug) = term.strip_prefix('@') {
                    vec![self.call("lookup", &[("slug", slug)], None).await?["brand"].clone()]
                } else {
                    let needle = term.to_lowercase();
                    self.rows("directory", &[("q", &term), ("limit", "200")], "brands")
                        .await?
                        .into_iter()
                        .filter(|b| {
                            ["name", "slug"].iter().any(|k| {
                                b[*k]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_lowercase()
                                    .contains(&needle)
                            })
                        })
                        .collect()
                };
                Ok(Outcome::Search(term, found))
            }
            Task::Invite(id) => {
                let response = self
                    .call("invitations", &[], Some(json!({"to_brand_id":id})))
                    .await?;
                Ok(Outcome::Changed(
                    if response["kind"] == "connected" {
                        "Connected"
                    } else {
                        "Request sent"
                    }
                    .into(),
                ))
            }
            Task::Respond(id, action) => {
                self.call(&format!("invitations/{id}/{action}"), &[], Some(json!({})))
                    .await?;
                Ok(Outcome::Changed(
                    match action {
                        "accept" => "Connected",
                        "decline" => "Request declined",
                        _ => "Request withdrawn",
                    }
                    .into(),
                ))
            }
            Task::Join => {
                let response = self
                    .call(
                        "join",
                        &[],
                        Some(json!({"source":"producer","rejoin":true})),
                    )
                    .await?;
                ensure!(
                    response["status"] == "joined",
                    "This workspace cannot join the network"
                );
                Ok(Outcome::Changed("Joined the network".into()))
            }
            Task::Visibility(id, value) => {
                ensure!(
                    self.bound == Some(id),
                    "This studio belongs to another workspace"
                );
                let response = self
                    .client
                    .patch(format!(
                        "{}/v1/app/live/rooms/{id}",
                        crate::boomin::DEFAULT_BOOMIN_API_ROOT
                    ))
                    .bearer_auth(&self.token)
                    .query(&[("brandSlug", &self.brand)])
                    .json(&json!({"visibility":value}))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<Value>()
                    .await?;
                ensure!(
                    response["room"]["visibility"] == value
                        && response["room"]["id"] == id.to_string(),
                    "Visibility change not confirmed"
                );
                Ok(Outcome::Visibility(id, value.to_owned()))
            }
            Task::RequestStudio(id) => {
                self.call("studio-requests", &[], Some(json!({"room_id":id}))).await?;
                Ok(Outcome::Changed("Studio request sent".into()))
            }
            Task::RespondStudio(id, action) => {
                self.call(&format!("studio-requests/{id}/{action}"), &[], Some(json!({}))).await?;
                Ok(Outcome::Changed(match action {
                    "approve" => "Studio request approved",
                    "decline" => "Studio request declined",
                    _ => "Studio request withdrawn",
                }.into()))
            }
            Task::JoinStudio(id) => {
                let data = self
                    .call(
                        &format!("studio-requests/{id}/join"),
                        &[],
                        Some(json!({})),
                    )
                    .await?;
                let url =
                    url::Url::parse(data["join_url"].as_str().context("Missing guest link")?)?;
                ensure!(
                    url.scheme() == "https"
                        && matches!(
                            url.host_str(),
                            Some("boomin.ai" | "app.boomin.ai" | "www.boomin.ai")
                        )
                        && url.path().starts_with("/connect/guest/"),
                    "Invalid guest destination"
                );
                Ok(Outcome::Entry(url.to_string()))
            }
        }
    }
}
fn worker<T: Send + 'static>(
    s: &Studio,
    job: impl FnOnce(Api, tokio::runtime::Runtime) -> Result<T> + Send + 'static,
) -> mpsc::Receiver<Result<T>> {
    let (tx, rx) = mpsc::channel();
    let base = s.base.clone();
    let root = s.live.as_ref().map(|l| l.handle.root.clone());
    let brand = s.settings.account.as_ref().unwrap().login.brand.clone();
    std::thread::spawn(move || {
        let result = (|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let bound = root.and_then(|root| {
                let binding: Value = serde_json::from_slice(
                    &std::fs::read(root.join("boomin/room-binding.json")).ok()?,
                )
                .ok()?;
                let room: Value =
                    serde_json::from_slice(&std::fs::read(root.join("room.json")).ok()?).ok()?;
                if binding["brandSlug"] != brand || binding["localRoom"] != room["room"] {
                    return None;
                }
                id(&binding["roomId"])
            });
            let api = Api {
                bound,
                client: crate::boomin_account::http()?,
                token: crate::boomin_account::room_token(&base, &brand)?,
                brand,
            };
            job(api, rt)
        })();
        let _ = tx.send(result);
    });
    rx
}
fn launch(s: &mut Studio, t: Task) {
    if s.network.action.is_some() || s.settings.account.is_none() {
        return;
    }
    s.network.notice.clear();
    s.network.action = Some(worker(s, move |api, rt| rt.block_on(api.run(t))));
}
pub(super) fn poll(s: &mut Studio) -> bool {
    let scope = s
        .settings
        .account
        .as_ref()
        .map(|a| (a.login.brand.clone(), a.email.clone()));
    let mut changed = false;
    if scope != s.network.scope {
        s.network = Network {
            scope,
            ..Default::default()
        };
        changed = true;
    }
    if s.network.scope.is_none() || s.live.is_none() {
        return changed;
    }
    if let Some(v) = s.network.refresh.as_ref().and_then(|rx| rx.try_recv().ok()) {
        s.network.refresh = None;
        s.network.next =
            Some(Instant::now() + Duration::from_secs(if v.is_err() { 15 } else { 4 }));
        match v {
            Ok(data) => {
                if let (Some(current), Some(previous)) = (&data.studio_requests, &s.network.data.studio_requests) {
                    if current.iter().any(|request| {
                        (request["direction"] == "incoming" && request["status"] == "pending"
                            || request["direction"] == "outgoing" && request["status"] == "approved")
                            && !previous.iter().any(|old| old["id"] == request["id"] && old["status"] == request["status"])
                    }) {
                        s.error = "New studio request activity in Network".into();
                    }
                }
                if s.network.synced
                    && pending(&data.incoming).any(|new| {
                        !s.network
                            .data
                            .incoming
                            .iter()
                            .any(|old| old["id"] == new["id"])
                    })
                {
                    s.error = "New connection request in Network".into();
                }
                s.network.synced = true;
                s.network.data = data;
                let active = s.network.data.connections.iter()
                    .filter(|row| row["connection"]["status"] == "active")
                    .filter_map(|row| avatar_url(&row["counterparty"]));
                let urls: std::collections::BTreeSet<_> = active.collect();
                s.network.logos.retain(|url, _| urls.contains(url.as_str()));
                s.network.sync_error.clear()
            }
            Err(e) => s.network.sync_error = e.to_string(),
        }
        changed = true;
    }
    if let Some(v) = s.network.action.as_ref().and_then(|rx| rx.try_recv().ok()) {
        s.network.action = None;
        match v {
            Ok(Outcome::Search(q, found)) => {
                s.network.found = found;
                s.network.searched = q;
            }
            Ok(Outcome::Visibility(id, value)) => {
                if let Some(room) = s
                    .settings
                    .account
                    .as_mut()
                    .and_then(|a| a.rooms.iter_mut().find(|r| r.id == id))
                {
                    room.visibility = Some(value);
                }
                s.network.notice = "Studio visibility updated".into();
            }
            Ok(Outcome::Entry(url)) => {
                s.network.notice =
                    match std::process::Command::new("/usr/bin/open").arg(url).spawn() {
                        Ok(_) => "Guest entry opened".into(),
                        Err(e) => e.to_string(),
                    };
            }
            Ok(Outcome::Changed(message)) => {
                s.network.notice = message;
                s.network.refresh = None;
                s.network.next = None;
            }
            Err(e) => s.network.notice = e.to_string(),
        }
        changed = true;
    }
    if s.network.refresh.is_none() && s.network.next.is_none_or(|t| Instant::now() >= t) {
        s.network.refresh = Some(worker(s, |api, rt| rt.block_on(api.refresh())));
    }
    if let Some(rx) = &s.network.logo_updates {
        loop {
            match rx.try_recv() {
                Ok((url, image)) => {
                    if let Some(logo) = s.network.logos.get_mut(&url) {
                        *logo = image.map(|img| {
                            let pixels = rune::Pixels::new();
                            pixels.set(img.width(), img.height(), img.into_raw());
                            pixels
                        });
                        changed = true;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    s.network.logo_updates = None;
                    break;
                }
            }
        }
    }
    if s.network.logo_updates.is_none() {
        fetch_connection_logos(&mut s.network);
    }
    changed
}

fn avatar_url(brand: &Value) -> Option<&str> {
    brand["avatarUrl"].as_str().or_else(|| brand["avatar_url"].as_str())
        .filter(|url| !url.trim().is_empty())
}

fn fetch_connection_logos(network: &mut Network) {
    let mut pending = Vec::new();
    for row in &network.data.connections {
        if row["connection"]["status"] != "active" {
            continue;
        }
        if let Some(url) = avatar_url(&row["counterparty"]) {
            if !network.logos.contains_key(url) {
                pending.push(url.to_owned());
                network.logos.insert(url.to_owned(), None);
            }
        }
    }
    if pending.is_empty() {
        return;
    }
    let (tx, rx) = mpsc::channel();
    network.logo_updates = Some(rx);
    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
            return;
        };
        rt.block_on(async move {
            let mut urls = pending.into_iter();
            let mut downloads = tokio::task::JoinSet::new();
            loop {
                while downloads.len() < 4 {
                    let Some(url) = urls.next() else { break };
                    downloads.spawn(async move {
                        let logo = crate::boomin_account::avatar(&url).await.ok();
                        (url, logo)
                    });
                }
                match downloads.join_next().await {
                    Some(Ok(result)) => if tx.send(result).is_err() { break; },
                    Some(Err(_)) => {}
                    None => break,
                }
            }
        });
    });
}
fn id(v: &Value) -> Option<Uuid> {
    v.as_str()?.parse().ok()
}
fn act(key: String, label: &str, t: Task) -> El {
    button(key, label, false, move |s| launch(s, t.clone()))
}
fn caption(name: &str) -> El {
    title(name, 12., 500., MUTED)
}
fn pending(rows: &[Value]) -> impl Iterator<Item = &Value> {
    rows.iter().filter(|r| r["status"] == "invited")
}

fn connected_studio<'a>(rooms: &'a [Value], brand_id: &Value) -> Option<&'a Value> {
    if !brand_id.is_string() {
        return None;
    }
    let visible = |room: &&Value| {
        room["brand"]["id"] == *brand_id
            && room["connected"] == true
            && matches!(room["visibility"].as_str(), Some("public" | "connections"))
    };
    rooms.iter().filter(visible).find(|r| r["status"] == "live")
        .or_else(|| rooms.iter().filter(visible).find(|r| r["status"] == "idle"))
}

fn connection_row(n: &Network, brand: &Value) -> El {
    let name = brand["name"].as_str().unwrap_or("Connected workspace");
    let initials: String = name.split_whitespace().take(2)
        .filter_map(|word| word.chars().next()).flat_map(char::to_uppercase).collect();
    let logo = el().size(32., 32.).radius(7.).clip_rounded(7.).fill(color(theme::AVATAR)).center();
    let logo = if let Some(image) = avatar_url(brand).and_then(|url| n.logos.get(url)).and_then(Option::as_ref) {
        logo.pixels_fit(image, SurfaceFit::Fill)
    } else {
        logo.child(title(initials, 11., 650., TEXT))
    };
    let studio = if n.sync_error.is_empty() {
        connected_studio(&n.data.rooms, &brand["id"])
    } else {
        None
    };
    let live = studio.is_some_and(|r| r["status"] == "live");
    let detail = if live {
        studio.and_then(|r| [r["show_title"].as_str(), r["title"].as_str()]
            .into_iter().flatten().find(|title| !title.trim().is_empty()))
            .unwrap_or("Live studio")
    } else if studio.is_some() {
        "Studio open"
    } else if !n.sync_error.is_empty() {
        "Status unavailable"
    } else {
        "Offline"
    };
    let mut row = row().key(format!("connection-{}", brand["id"].as_str().unwrap_or(name)))
        .w_full().min_w(0.).items_center().gap(8.).padding(7.)
        .radius(7.).fill(color(theme::ROW))
        .child(logo)
        .child(col().min_w(0.).grow(1.).gap(2.)
            .child(title(name, 12., 550., TEXT))
            .child(title(detail, 11., if live { 500. } else { 400. }, if live { MINT } else { MUTED })));
    if live {
        row = row.child(el().size(6., 6.).radius(3.).fill(color(MINT)).help("Live"));
    }
    row
}

fn studio_outgoing(n: &Network, room: Uuid) -> Option<&Value> {
    n.data.studio_requests.as_ref()?.iter().find(|request| {
        id(&request["room_id"]) == Some(room) && request["direction"] == "outgoing"
            && matches!(request["status"].as_str(), Some("pending" | "approved"))
    })
}

fn studio_request_button(n: &Network, room: Uuid) -> El {
    if let Some(request) = studio_outgoing(n, room) {
        if request["status"] == "approved" {
            if let Some(id) = id(&request["id"]) {
                return act(format!("join-studio-{id}"), "Join studio", Task::JoinStudio(id));
            }
        }
        return caption("Request pending");
    }
    act(format!("request-studio-{room}"), "Request to join", Task::RequestStudio(room))
        .disabled(n.data.studio_requests.is_none())
        .help(if n.data.studio_requests.is_none() { "Studio requests are unavailable" } else { "Send a request to this studio’s host" })
}

fn studio_requests(n: &Network, mut body: El) -> El {
    let Some(requests) = &n.data.studio_requests else {
        return body.child(caption("Studio requests are unavailable"));
    };
    for (direction, heading) in [("incoming", "Received"), ("outgoing", "Sent")] {
        body = body.child(title(heading, 12., 600., TEXT));
        let mut items = requests.iter().filter(|r| r["direction"] == direction).peekable();
        if items.peek().is_none() {
            body = body.child(caption("No studio requests"));
        }
        for request in items {
            let Some(key) = id(&request["id"]) else { continue };
            let status = match request["status"].as_str() {
                Some("pending") => "Pending",
                Some("approved") => "Approved",
                Some("declined") => "Declined",
                Some("withdrawn") => "Withdrawn",
                Some("expired") => "Expired",
                _ => continue,
            };
            let name = request["counterparty"]["name"].as_str().unwrap_or("Workspace");
            let mut card = col().w_full().min_w(0.).gap(5.).padding(8.)
                .fill(color(theme::ROW)).radius(7.)
                .child(title(request["title"].as_str().unwrap_or("Studio"), 12., 600., TEXT))
                .child(caption(&format!("{name} · {status}")));
            let mut actions = row().gap(4.).flex_wrap();
            if direction == "incoming" && status == "Pending" {
                actions = actions
                    .child(act(format!("approve-studio-{key}"), "Approve", Task::RespondStudio(key, "approve")))
                    .child(act(format!("decline-studio-{key}"), "Decline", Task::RespondStudio(key, "decline")));
                card = card.child(actions);
            } else if direction == "outgoing" && matches!(status, "Pending" | "Approved") {
                if status == "Approved" && request["studio_open"] == true {
                    actions = actions.child(act(format!("join-studio-{key}"), "Join studio", Task::JoinStudio(key)));
                }
                card = card.child(actions.child(act(format!("withdraw-studio-{key}"), "Withdraw", Task::RespondStudio(key, "withdraw"))));
            }
            body = body.child(card);
        }
    }
    body
}

const SECTIONS: [(&str, &str); 4] = [
    ("Connected", "link"),
    ("Find", "search"),
    ("Requests", "inbox"),
    ("Studios", "door"),
];

pub(super) fn switcher(s: &Studio) -> Option<El> {
    let n = &s.network;
    if s.settings.account.is_none() || n.data.requires_membership {
        return None;
    }
    let count = pending(&n.data.incoming).count()
        + n.data.studio_requests.iter().flatten()
            .filter(|r| r["direction"] == "incoming" && r["status"] == "pending").count();
    let mut tabs = row()
        .key("network-switcher")
        .role("tablist")
        .label("Network")
        .orientation(rune::Orientation::Horizontal)
        .focus_group()
        .w_full()
        .max_w(236.)
        .h(34.)
        .padding(3.)
        .gap(2.)
        .radius(8.)
        .fill(color(BG))
        .border(1., color(theme::TAB_BORDER));

    for (index, (name, glyph)) in SECTIONS.into_iter().enumerate() {
        let active = n.tab == index;
        let unread = glyph == "inbox" && count > 0;
        let label = if unread {
            format!("Requests · {count} incoming")
        } else {
            name.into()
        };
        let icon =
            rune::icon(glyphs::glyph(glyph), 17.).color(color(if active { MINT } else { MUTED }));
        let icon = if unread {
            let badge = if count > 9 {
                "9+".into()
            } else {
                count.to_string()
            };
            el().size(17., 17.).child(icon).child(
                el().key("network-request-count")
                    .absolute(12., -4.)
                    .size(if count > 9 { 17. } else { 12. }, 12.)
                    .radius(6.)
                    .center()
                    .fill(color(MINT))
                    .child(title(badge, 8., 700., BG)),
            )
        } else {
            icon
        };
        tabs = tabs.child(
            el().key(format!("network-tab-{index}"))
                .role("tab")
                .label(label.clone())
                .help(label)
                .controls("network-section")
                .focusable(true)
                .focus_selected(active)
                .w(0.)
                .min_w(0.)
                .grow(1.)
                .h_full()
                .center()
                .radius(5.)
                .fill(color(if active { 0x193a32 } else { BG }))
                .hover_fill(color(if active { theme::SELECTED_HOVER } else { SURFACE }))
                .child(icon)
                .on_press(move |s: &mut Studio| s.network.tab = index),
        );
    }
    Some(tabs)
}

pub(super) fn panel(s: &Studio, mut b: El) -> El {
    let n = &s.network;
    if s.settings.account.is_none() {
        return b.child(button("network-account", "Sign in to Boomin", false, |s| {
            s.page = Page::Studios;
            s.settings.profile_open = true;
        }));
    }
    if n.data.requires_membership {
        return b
            .child(act(
                "network-join".into(),
                "Join Boomin Network",
                Task::Join,
            ))
            .child(caption(&n.notice));
    }
    b = b.gap(6.)
        .key("network-section")
        .role("tabpanel")
        .label(SECTIONS[n.tab].0);
    match n.tab {
        0 => {
            let mut empty = true;
            for c in &n.data.connections {
                if c["connection"]["status"] != "active" {
                    continue;
                }
                empty = false;
                b = b.child(connection_row(n, &c["counterparty"]));
            }
            if empty {
                b = b.child(caption("No active connections"))
            }
        }
        1 => {
            fn search(s: &mut Studio) {
                let q = s.network.query.text.trim().to_owned();
                if !q.is_empty() {
                    launch(s, Task::Search(q));
                }
            }
            b = b.child(row().items_center().w_full().min_w(0.).gap(4.)
                .child(field("network-query", &n.query, |s| &mut s.network.query)
                    .placeholder("Name or @handle", color(MUTED)).w(0.).grow(1.)
                    .label("Search the network").on_submit(|s: &mut Studio, _| search(s)))
                .child(panels::tool("network-search", "search", "Search the network", false, search)));
            if n.query.text.trim() == n.searched && !n.searched.is_empty() {
                if n.found.is_empty() {
                    b = b.child(caption("No matching workspaces"))
                }
                for brand in &n.found {
                    let Some(target) = id(&brand["id"]).or_else(|| id(&brand["brandId"])) else {
                        continue;
                    };
                    b = b.child(title(
                        brand["name"].as_str().unwrap_or("Workspace"),
                        13.,
                        550.,
                        TEXT,
                    ));
                    if n.data.connections.iter().any(|c| {
                        id(&c["counterparty"]["id"]) == Some(target)
                            && c["connection"]["status"] == "active"
                    }) {
                        b = b.child(caption("Connected"))
                    } else if pending(&n.data.outgoing)
                        .any(|r| id(&r["brand"]["id"]) == Some(target))
                    {
                        b = b.child(caption("Pending"))
                    } else if let Some(request) = pending(&n.data.incoming)
                        .find(|r| id(&r["brand"]["id"]) == Some(target))
                        .and_then(|r| id(&r["id"]))
                    {
                        b = b.child(act(
                            format!("accept-{request}"),
                            "Accept request",
                            Task::Respond(request, "accept"),
                        ))
                    } else {
                        b = b.child(act(
                            format!("invite-{target}"),
                            "Send request",
                            Task::Invite(target),
                        ))
                    }
                }
            }
        }
        2 => {
            b = b.child(row().gap(4.).flex_wrap()
                .child(button("connection-requests", "Connections", !n.studio_requests_selected, |s| s.network.studio_requests_selected = false))
                .child(button("studio-requests", "Studio entry", n.studio_requests_selected, |s| s.network.studio_requests_selected = true)));
            if n.studio_requests_selected {
                b = studio_requests(n, b);
            } else {
            for (incoming, items, heading) in [
                (true, &n.data.incoming, "Received"),
                (false, &n.data.outgoing, "Sent"),
            ] {
                b = b.child(title(heading, 13., 600., TEXT));
                if pending(items).next().is_none() {
                    b = b.child(caption("No pending requests"))
                }
                for r in pending(items) {
                    let Some(key) = id(&r["id"]) else { continue };
                    b = b.child(title(
                        r["brand"]["name"].as_str().unwrap_or("Workspace"),
                        13.,
                        500.,
                        TEXT,
                    ));
                    let mut actions = row().gap(4.);
                    for (label, verb) in if incoming {
                        vec![("Accept", "accept"), ("Decline", "decline")]
                    } else {
                        vec![("Withdraw", "revoke")]
                    } {
                        actions = actions.child(act(
                            format!("{verb}-{key}"),
                            label,
                            Task::Respond(key, verb),
                        ));
                    }
                    b = b.child(actions);
                }
            }
            }
        }
        _ => {
            if let Some(room) = n.data.bound.and_then(|key| {
                s.settings
                    .account
                    .as_ref()?
                    .rooms
                    .iter()
                    .find(|r| r.id == key)
            }) {
                b = b.child(title("This studio’s visibility", 13., 600., TEXT));
                let mut choices = row().gap(4.).flex_wrap();
                for (label, value) in [
                    ("Private", "private"),
                    ("Connections", "connections"),
                    ("Public", "public"),
                ] {
                    let key = room.id;
                    choices = choices.child(button(
                        format!("room-visibility-{value}"),
                        label,
                        room.visibility.as_deref() == Some(value),
                        move |s| launch(s, Task::Visibility(key, value)),
                    ));
                }
                b = b.child(choices).child(title("Open studios", 13., 600., TEXT));
            }
            if n.data.rooms.is_empty() {
                b = b.child(caption("No open studios available"))
            }
            for r in &n.data.rooms {
                let vis = match r["visibility"].as_str() {
                    Some("public") => "Public",
                    Some("connections") if r["connected"] == true => "Connections only",
                    _ => continue,
                };
                let Some(key) = id(&r["room_id"]) else {
                    continue;
                };
                b = b
                    .child(title(
                        r["title"].as_str().unwrap_or("Studio"),
                        13.,
                        600.,
                        TEXT,
                    ))
                    .child(caption(&format!(
                        "{} · {vis}",
                        r["brand"]["name"].as_str().unwrap_or("Workspace")
                    )))
                    .child(studio_request_button(n, key));
            }
        }
    }
    for msg in [&n.notice, &n.sync_error] {
        if !msg.is_empty() {
            b = b.child(caption(msg))
        }
    }
    if n.action.is_some() {
        b = b.child(caption("Working…"))
    }
    b
}
