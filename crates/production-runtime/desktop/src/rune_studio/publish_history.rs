use super::*;
use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub(super) struct Post {
    platform: String,
    status: String,
    caption: String,
    #[serde(skip)]
    excerpt: String,
    posted_at: Option<String>,
    created_at: String,
    post_type: String,
    platform_permalink: Option<String>,
    channel_id: Option<String>,
    thumbnail_url: Option<String>,
}
impl Post {
    fn date(&self) -> &str {
        self.posted_at.as_deref().unwrap_or(&self.created_at)
    }
}
pub(super) struct History {
    posts: Vec<Post>,
    accounts: Vec<AccountMetrics>,
    instagram: usize,
}
struct AccountMetrics {
    id: String,
    provider: String,
    name: String,
    followers: Option<u64>,
}
impl History {
    pub async fn fetch(api: &super::publish::Api) -> Result<Self> {
        let (posts, accounts) = tokio::join!(
            api.call("content/social-posts", None, None, &[]),
            api.call("channels/list", None, None, &[])
        );
        let mut data = posts?;
        let mut posts: Vec<Post> =
            serde_json::from_value(data["posts"].take()).context("Invalid published timeline")?;
        posts.retain(|p| {
            p.status == "published" && matches!(p.platform.as_str(), "instagram" | "threads")
        });
        posts.sort_by(|a, b| b.date().cmp(a.date()));
        let accounts = accounts.unwrap_or(Value::Null);
        let accounts = accounts["channels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| {
                matches!(c["provider"].as_str(), Some("instagram" | "threads"))
                    && c["status"] == "connected"
            })
            .filter_map(|c| {
                Some(AccountMetrics {
                    id: c["integration_id"].as_str()?.to_owned(),
                    provider: c["provider"].as_str()?.to_owned(),
                    name: c["name"].as_str()?.to_owned(),
                    followers: c["metrics_preview"]["followers"].as_u64(),
                })
            })
            .collect();
        let instagram = posts.iter().filter(|p| p.platform == "instagram").count();
        for p in &mut posts {
            p.excerpt = p
                .caption
                .split_whitespace()
                .take(30)
                .collect::<Vec<_>>()
                .join(" ");
        }
        Ok(Self {
            posts,
            accounts,
            instagram,
        })
    }
    pub fn preview_urls(&self, limit: usize) -> impl Iterator<Item = &str> {
        self.posts.iter().take(limit).filter_map(|post| {
            post.thumbnail_url.as_deref().filter(|url| !url.is_empty())
        })
    }

    pub fn metrics(&self, s: &Studio, mut b: El) -> El {
        b = b.child(
            row().items_center().gap(6.)
                .child(title(self.posts.len().to_string(), 23., 700., TEXT))
                .child(title("published posts", 12., 500., MUTED)),
        );
        for pair in self.accounts.chunks(2) {
            let mut accounts = row().w_full().gap(5.);
            for account in pair {
                let count = self.posts.iter().filter(|post| post.channel_id.as_ref() == Some(&account.id)).count();
                let posts = format!("{count} {}", if count == 1 { "post" } else { "posts" });
                let mut labels = col().grow(1.).min_w(0.)
                    .child(title(&account.name, 11., 650., TEXT))
                    .child(title(&posts, 9., 450., MUTED));
                if let Some(followers) = account.followers {
                    let followers = format!("{followers} {}", if followers == 1 { "follower" } else { "followers" });
                    labels = labels.child(title(followers, 9., 450., MUTED));
                }
                accounts = accounts.child(row().w(0.).min_w(0.).grow(1.).items_center().gap(4.)
                    .padding(6.).radius(7.).border(1., color(theme::TRANSPORT_BORDER)).fill(color(SURFACE))
                    .help(format!("{} · {}", super::publish::platform(&account.provider), account.name))
                    .child(super::publish::channel_avatar(s, &account.id, &account.provider, &account.name))
                    .child(labels));

            }
            b = b.child(accounts);
        }
        if self.accounts.is_empty() {
            b = b.child(title(format!("Instagram {}   ·   Threads {}", self.instagram, self.posts.len() - self.instagram),
                11., 450., MUTED));
        }
        b
    }
    pub fn timeline(&self, s: &Studio, mut b: El, limit: usize) -> El {
        if self.posts.is_empty() {
            return b.child(title("No published posts yet", 12., 450., MUTED));
        }
        for post in self.posts.iter().take(limit) {
            let date = post.date().split('T').next().unwrap_or(post.date());
            let mut card = row().w_full().min_w(0.).items_center().gap(8.)
                .padding(6.).radius(7.).border(1., color(theme::TRANSPORT_BORDER)).fill(color(SURFACE));
            if let Some(thumb) = post.thumbnail_url.as_deref().and_then(|url| s.publish.downloaded_preview(url)) {
                let mut preview = el().size(64., 40.).radius(4.).clip_rounded(4.)
                    .role("img").label("Published media preview").pixels_fit(thumb, SurfaceFit::Fill);
                if matches!(post.post_type.as_str(), "video" | "short-video" | "reel") {
                    preview = preview.child(el().absolute(3., 3.).size(17., 17.).center().radius(4.)
                        .fill(color(BG).alpha(0.85)).child(super::publish::publish_icon("play", 11., TEXT)));
                }
                card = card.child(preview);
            }
            card = card.child(col().grow(1.).min_w(0.).gap(3.).py(2.)
                .child(title(format!("{} · {date}", super::publish::platform(&post.platform)), 10., 500., MUTED))
                .child(title(if post.excerpt.is_empty() { &post.post_type } else { &post.excerpt },
                    12., 550., TEXT).help(&post.caption)));
            if let Some(url) = post
                .platform_permalink
                .as_ref()
                .and_then(|s| url::Url::parse(s).ok())
                .filter(|u| {
                    u.scheme() == "https"
                        && matches!(
                            u.host_str(),
                            Some(
                                "instagram.com"
                                    | "www.instagram.com"
                                    | "threads.net"
                                    | "www.threads.net"
                                    | "threads.com"
                                    | "www.threads.com"
                            )
                        )
                })
            {
                card = card
                    .role("link")
                    .hover_fill(color(theme::ROW))
                    .focusable(true)
                    .help("Open published post")
                    .on_press(move |_: &mut Studio| {
                        let _ = std::process::Command::new("/usr/bin/open")
                            .arg(url.as_str())
                            .spawn();
                    });
            }
            b = b.child(card);
        }
        if self.posts.len() > limit {
            b = b.child(button(
                "publish-more-posts",
                "Show older posts",
                false,
                |s| {
                    s.publish.limit += 20;
                    s.publish.load_avatars();
                },
            ));
        }
        b
    }
}
