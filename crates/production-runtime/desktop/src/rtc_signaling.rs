//! Short-lived, authenticated SDP exchange. Media never passes through this client.
use anyhow::{anyhow,bail,Context,Result};
use serde_json::Value;
use std::{io::Write,process::{Command,Stdio}};
use url::Url;

pub struct Link { pub page:String, pub guest:String }
fn validate_origin(u:&Url)->Result<()> {
    let local=u.scheme()=="http" && matches!(u.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"));
    if !(u.scheme()=="https"||local)||u.host_str().is_none()||!u.username().is_empty()||u.password().is_some()||u.query().is_some() {
        bail!("The studio needs an HTTPS address or a local development address");
    }
    Ok(())
}
pub fn origin(value:&str)->Result<String>{
    let u=Url::parse(value)?; validate_origin(&u)?;
    if u.path()!="/"||u.fragment().is_some(){bail!("Expected a signaling origin");}
    Ok(u.origin().ascii_serialization())
}
pub fn parse(value:&str)->Result<Link>{
    let mut u=Url::parse(value.trim()).context("Copy a Producer studio link first")?;
    validate_origin(&u)?;
    let id=u.path().strip_prefix("/r/").unwrap_or_default();
    if id.len()!=36 || !id.bytes().all(|b| b.is_ascii_hexdigit()||b==b'-'){bail!("Invalid studio link");}
    let guest=u.fragment().unwrap_or_default().to_owned();
    if guest.len()!=64||!guest.bytes().all(|b| b.is_ascii_hexdigit()){bail!("Studio invitation is incomplete");}
    u.set_fragment(None);
    Ok(Link{page:u.to_string(),guest})
}

pub const BROWSER_SIGNALING_ORIGIN: &str =
    "https://producer-rune-guest-dev.kleveland-bishop.workers.dev";

pub fn browser_invitation(value: &str) -> Result<String> {
    let link = parse(value)?;
    let page = Url::parse(&link.page)?;
    // The branded guest page resolves this one broker. Custom brokers keep
    // their own invitations and their own browser entry page.
    if page.origin().ascii_serialization() != BROWSER_SIGNALING_ORIGIN {
        return Ok(value.to_owned());
    }
    let id = page.path().trim_start_matches("/r/");
    Ok(format!("https://producer.dev/connect/guest/gi_rtc_{id}#{}", link.guest))
}
/// Pass credentials and SDP through stdin only. curl performs normal TLS
/// certificate checks, has bounded time/size and never follows redirects.
pub fn request(method:&str,url:&str,token:&str,body:Option<&Value>)->Result<Value>{
    if token.is_empty()||token.len()>512 || !token.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_.".contains(&b)){bail!("Invalid signaling credential");}
    let quote=|s:&str| serde_json::to_string(s).unwrap();
    let mut config=format!("request = {}\nurl = {}\nheader = {}\n",method,quote(url),quote(&format!("Authorization: Bearer {token}")));
    if let Some(data)=body {config+=&format!("header = \"Content-Type: application/json\"\ndata-binary = {}\n",quote(&data.to_string()));}
    let mut child=Command::new("/usr/bin/curl").args(["-q","--silent","--show-error","--max-time","5","--max-filesize","98304","--proto","=http,https","--config","-"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    child.stdin.take().unwrap().write_all(config.as_bytes())?;
    let output=child.wait_with_output()?;
    if !output.status.success(){bail!("Signaling service unreachable");}
    let reply:Value=serde_json::from_slice(&output.stdout).context("Invalid signaling response")?;
    if reply.get("error").is_some(){return Err(anyhow!("Room invitation unavailable or expired"));}
    Ok(reply)
}
#[test]
fn only_secure_public_links_or_loopback_are_accepted(){
    let path=format!("/r/12345678-1234-1234-1234-123456789012#{}","a".repeat(64));
    assert!(parse(&format!("https://example.org{path}")).is_ok());
    assert!(parse(&format!("http://127.0.0.1:8798{path}")).is_ok());
    assert!(parse(&format!("http://example.org{path}")).is_err());
    assert!(parse(&format!("file://example.org{path}")).is_err());
}
