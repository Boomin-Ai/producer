use super::*;
use anyhow::{ensure, Result};
use serde_json::Value;
use std::path::Path;

const REPLIES: [(&str, &str); 3] = [
    ("everyone", "Everyone"),
    ("accounts_you_follow", "Accounts you follow"),
    ("mentioned_only", "Mentioned accounts"),
];

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum InstagramFormat { Post, Reel, Story }

impl InstagramFormat {
    pub fn key(self) -> &'static str {
        match self { Self::Post => "post", Self::Reel => "reel", Self::Story => "story" }
    }

    pub fn requirement(self, files: &[PathBuf]) -> Option<&'static str> {
        use InstagramFormat::*;
        match self {
            Post if files.is_empty() || files.iter().any(|f| video(Some(f))) => Some("Add photos for an Instagram post."),
            Reel if files.len() != 1 || !video(files.first().map(PathBuf::as_path)) => Some("Add one video for an Instagram Reel."),
            Story if files.len() != 1 => Some("Add one photo or video for an Instagram Story."),
            _ => None,
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct Options {
    pub format: Option<InstagramFormat>,
    custom: bool,
    caption: TextEdit,
    hide_from_feed: bool,
    location: TextEdit,
    tags: TextEdit,
    collaborators: TextEdit,
    pub cover: Option<PathBuf>,
    trial: bool,
    replies: usize,
}
pub(super) fn video(file: Option<&Path>) -> bool {
    file.and_then(Path::extension)
        .and_then(|v| v.to_str())
        .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "mov" | "mp4"))
}
fn handles(raw: &str) -> Vec<String> {
    let mut list = Vec::new();
    for term in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        let term = term.trim_start_matches('@');
        if !term.is_empty()
            && !list
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(term))
        {
            list.push(term.to_owned());
        }
    }
    list
}
impl Options {
    pub fn format(&self, file: Option<&Path>) -> InstagramFormat {
        self.format.unwrap_or(if video(file) { InstagramFormat::Reel } else { InstagramFormat::Post })
    }

    pub fn payload(&self, provider: &str, global: &str, file: Option<&Path>) -> Result<Value> {
        let caption = if self.custom {
            self.caption.text.trim()
        } else {
            global.trim()
        };
        let limit = if provider == "threads" { 500 } else { 2200 };
        ensure!(
            caption.chars().count() <= limit,
            "{} caption exceeds {limit} characters",
            super::publish::platform(provider)
        );
        ensure!(
            file.is_some() || provider == "threads" && !caption.is_empty(),
            "Add media or a Threads caption"
        );
        ensure!(
            !self.custom || !caption.is_empty() || global.trim().is_empty(),
            "Enter a custom caption or choose Use main caption"
        );
        let mut opts = json!({});
        if self.custom {
            opts["caption"] = json!(caption);
        }
        if provider == "threads" {
            opts["reply_control"] = json!(REPLIES[self.replies].0);
        } else if self.format(file) != InstagramFormat::Story {
            let place = self.location.text.trim();
            ensure!(
                place.bytes().all(|b| b.is_ascii_digit()),
                "Instagram location needs a numeric place ID"
            );
            if !place.is_empty() {
                opts["location"] = json!(place);
            }
            let tags = handles(&self.tags.text);
            let collaborators = handles(&self.collaborators.text);
            ensure!(
                collaborators.len() <= 3,
                "Choose up to three Instagram collaborators"
            );
            if !tags.is_empty() {
                opts["userTags"] = json!(tags);
            }
            if !collaborators.is_empty() {
                opts["collaborators"] = json!(collaborators);
            }
            if video(file) {
                opts["feed"] = json!(!self.hide_from_feed);
                opts["trial_post"] = json!(self.trial);
            }
        }
        Ok(opts)
    }
}

pub(super) fn controls(s: &Studio, id: &str, provider: &str) -> El {
    let defaults = Options::default();
    let o = s.publish.options.get(id).unwrap_or(&defaults);
    let mut box_ = col()
        .w_full()
        .min_w(0.)
        .gap(5.)
        .padding(8.)
        .radius(6.)
        .fill(color(PANEL));
    let id = id.to_owned();
    let main_id = id.clone();
    let custom_id = id.clone();
    box_ = box_.child(title("Caption", 11., 550., MUTED)).child(
        row().flex_wrap().gap(4.)
            .child(button("publish-main-caption", "Use main caption", !o.custom, move |s| {
                s.publish.options.entry(main_id.clone()).or_default().custom = false;
            }).h(24.))
            .child(button("publish-custom-caption", "Custom caption", o.custom, move |s| {
                let options = s.publish.options.entry(custom_id.clone()).or_default();
                if !options.custom && options.caption.text.is_empty() {
                    options.caption = TextEdit::new(&s.publish.caption.text);
                }
                options.custom = true;
            }).h(24.)),
    );
    macro_rules! input {
        ($key:literal,$label:literal,$field:ident) => {{
            let key = id.clone();
            box_ = box_.child(title($label, 11., 500., MUTED)).child(field(
                $key,
                &o.$field,
                move |s| &mut s.publish.options.entry(key.clone()).or_default().$field,
            ));
        }};
    }
    if o.custom {
        input!("publish-override", "Channel caption", caption);
    }
    if provider == "threads" {
        box_ = box_.child(title("Who can reply", 11., 550., MUTED));
        let mut choices = row().flex_wrap().gap(3.);
        for (index, (_, name)) in REPLIES.iter().enumerate() {
            let key = id.clone();
            choices = choices.child(button(
                format!("publish-reply-{index}"),
                *name,
                o.replies == index,
                move |s| s.publish.options.entry(key.clone()).or_default().replies = index,
            ));
        }
        return box_.child(choices);
    }
    let format = o.format(s.publish.files.first().map(PathBuf::as_path));
    if format == InstagramFormat::Story { return box_; }
    let reel = format == InstagramFormat::Reel;
    if reel {
        let key = id.clone();
        box_ = box_.child(button(
            "publish-feed",
            format!(
                "Show on feed · {}",
                if o.hide_from_feed { "Off" } else { "On" }
            ),
            !o.hide_from_feed,
            move |s| {
                let o = s.publish.options.entry(key.clone()).or_default();
                o.hide_from_feed = !o.hide_from_feed;
            },
        ));
    }
    input!(
        "publish-location",
        "Location · Instagram place ID",
        location
    );
    input!("publish-tags", "User tags · @names, comma separated", tags);
    input!(
        "publish-collaborators",
        "Collaborators · up to 3 @names",
        collaborators
    );
    if reel {
        let key = id.clone();
        if let Some(path) = &o.cover {
            box_ = box_
                .child(title(
                    path.file_name().unwrap_or_default().to_string_lossy(),
                    11.,
                    500.,
                    TEXT,
                ))
                .child(button(
                    "publish-clear-cover",
                    "Remove cover",
                    false,
                    move |s| s.publish.options.entry(key.clone()).or_default().cover = None,
                ));
        }
        let key = id.clone();
        box_ = box_.child(
            el().key("publish-cover")
                .label("Choose Reel cover")
                .role("button")
                .focusable(true)
                .h(28.)
                .center()
                .fill(color(SURFACE))
                .radius(5.)
                .child(title("Choose Reel cover…", 11., 500., TEXT))
                .on_press_tx(move |s: &mut Studio, tx| {
                    let key = key.clone();
                    let scope = s.publish.scope.clone();
                    tx.open_file(
                        rune::FileDialogOptions::default().filter("Image", &["jpg", "jpeg", "png"]),
                        move |s: &mut Studio, result, _| {
                            if s.publish.scope != scope {
                                return;
                            }
                            match result {
                                Ok(Some(path)) => {
                                    s.publish.options.entry(key.clone()).or_default().cover =
                                        Some(path)
                                }
                                Err(e) => s.publish.notice = e.to_string(),
                                _ => {}
                            }
                        },
                    )
                }),
        );
        box_ = box_.child(button(
            "publish-trial",
            format!("Trial reel · {}", if o.trial { "On" } else { "Off" }),
            o.trial,
            move |s| {
                let o = s.publish.options.entry(id.clone()).or_default();
                o.trial = !o.trial;
            },
        ));
    }
    box_
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_selected_channel_and_media_options_reach_the_submission() {
        let o = Options {
            custom: true,
            caption: TextEdit::new("Mine"),
            hide_from_feed: true,
            location: TextEdit::new("123"),
            tags: TextEdit::new("@anna, Anna @host"),
            collaborators: TextEdit::new("@guest"),
            trial: true,
            replies: 2,
            ..Default::default()
        };
        assert_eq!(
            o.payload("threads", "Global", None).unwrap(),
            json!({"caption":"Mine","reply_control":"mentioned_only"})
        );
        assert_eq!(
            o.payload("instagram", "Global", Some(Path::new("test.mp4")))
                .unwrap(),
            json!({"caption":"Mine","feed":false,"trial_post":true,"location":"123","userTags":["anna","host"],"collaborators":["guest"]})
        );
        assert!(o
            .payload("instagram", "Global", Some(Path::new("test.jpg")))
            .unwrap()
            .get("trial_post")
            .is_none());
    }
}
