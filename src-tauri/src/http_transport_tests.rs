//! Loopback-only regressions for the actual shared pools and API client.
//! No environment changes, certificate overrides, external servers, or real credentials.

use crate::{client::ProducerClient, http_transport};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}
struct Reply {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: &'static str,
    delay: Duration,
}
impl Reply {
    fn json(body: &'static str) -> Self {
        Self {
            status: "200 OK",
            headers: vec![],
            body,
            delay: Duration::ZERO,
        }
    }
}
struct Server {
    base: String,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Server {
    fn start(reply: impl Fn(&Request) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let reply = Arc::new(reply);
        let worker = std::thread::spawn(move || {
            let mut children = Vec::new();
            let deadline = Instant::now() + Duration::from_secs(30);
            while !done.load(Ordering::Acquire) && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("loopback accept: {error}"),
                };
                assert!(
                    children.len() < 16,
                    "loopback fixture exceeded its connection bound"
                );
                let seen = seen.clone();
                let reply = reply.clone();
                children.push(std::thread::spawn(move || {
                    // Darwin can inherit O_NONBLOCK from the listener.
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    stream.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut bytes = Vec::new();
                    let mut one = [0u8; 1];
                    let read_deadline = Instant::now() + Duration::from_secs(3);
                    while !bytes.ends_with(b"\r\n\r\n") {
                        if Instant::now() >= read_deadline || stream.read_exact(&mut one).is_err() {
                            return;
                        }
                        bytes.push(one[0]);
                        assert!(bytes.len() < 16384);
                    }
                    let text = String::from_utf8(bytes).unwrap();
                    let mut lines = text.split("\r\n");
                    let first = lines.next().unwrap().split_whitespace().collect::<Vec<_>>();
                    let headers = lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(key, value)| (key.to_string(), value.trim().to_string()))
                        .collect::<Vec<_>>();
                    let length = headers
                        .iter()
                        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.parse::<usize>().unwrap())
                        .unwrap_or(0);
                    assert!(length < 16384);
                    let mut body = vec![0; length];
                    if stream.read_exact(&mut body).is_err() {
                        return;
                    }
                    let request = Request {
                        method: first[0].into(),
                        target: first[1].into(),
                        headers,
                        body,
                    };
                    let response = reply(&request);
                    seen.lock().unwrap().push(request);
                    assert!(response.delay <= Duration::from_secs(8));
                    std::thread::sleep(response.delay);
                    let mut wire=format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",response.status,response.body.len());
                    for (key, value) in response.headers {
                        wire.push_str(&format!("{key}: {value}\r\n"));
                    }
                    wire.push_str("\r\n");
                    wire.push_str(response.body);
                    let _ = stream.write_all(wire.as_bytes());
                }));
            }
            for child in children {
                child.join().unwrap();
            }
        });
        Self {
            base,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn received(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn actual_clients_keep_bearer_brand_and_upload_capabilities_request_scoped() {
    let server = Server::start(|_| {
        let mut response = Reply::json("{}");
        response.headers.push((
            "Set-Cookie".into(),
            "synthetic_session=must-not-persist; Path=/".into(),
        ));
        response
    });
    let base = format!("{}/v1/app/producer", server.base);
    let alpha = ProducerClient::new(&base, "synthetic-alpha").with_brand(Some("red".into()));
    let beta = ProducerClient::new(&base, "synthetic-beta").with_brand(Some("blue".into()));
    let (a, b) = tokio::join!(alpha.list_rooms(), beta.network_status());
    a.unwrap();
    b.unwrap();
    alpha
        .put_bytes(
            &format!("{}/upload?capability=synthetic", server.base),
            "application/octet-stream",
            b"abc".to_vec(),
        )
        .await
        .unwrap();
    let seen = server.received();
    assert_eq!(seen.len(), 3);
    let rooms = seen
        .iter()
        .find(|r| r.target == "/v1/app/live/rooms?brandSlug=red")
        .unwrap();
    assert_eq!(
        rooms.header("authorization"),
        Some("Bearer synthetic-alpha")
    );
    let network = seen
        .iter()
        .find(|r| r.target == "/v1/app/network?brandSlug=blue")
        .unwrap();
    assert_eq!(
        network.header("authorization"),
        Some("Bearer synthetic-beta")
    );
    let upload = seen.iter().find(|r| r.method == "PUT").unwrap();
    assert_eq!(upload.header("authorization"), None);
    assert_eq!(upload.body, b"abc");
    assert!(
        seen.iter().all(|r| r.header("cookie").is_none()),
        "default client unexpectedly stored response cookies"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn actual_room_access_keeps_401_and_403_denials_distinct_from_missing_route() {
    let server = Server::start(|r| {
        let mut response = Reply::json("{\"error\":{\"message\":\"synthetic denial\"}}");
        response.status = if r.target.contains("missing") {
            "404 Not Found"
        } else if r.target.contains("unauthorized") {
            "401 Unauthorized"
        } else {
            "403 Forbidden"
        };
        response
    });
    let client = ProducerClient::new(&server.base, "synthetic-access");
    for (room, status) in [("unauthorized", 401), ("forbidden", 403)] {
        let result = client.room_access(room).await.unwrap();
        assert_eq!(result["available"], true);
        assert_eq!(result["denied"], true);
        assert_eq!(result["status"], status);
    }
    assert_eq!(
        client.room_access("missing").await.unwrap(),
        serde_json::json!({"available":false})
    );
    assert!(server
        .received()
        .iter()
        .all(|r| r.header("authorization") == Some("Bearer synthetic-access")));
}

#[cfg(feature = "guest-rtc-pilot")]
#[tokio::test(flavor = "current_thread")]
async fn general_follows_default_redirect_but_rtc_pool_does_not() {
    let server = Server::start(|r| {
        if r.target == "/jump" {
            let mut response = Reply::json("{}");
            response.status = "302 Found";
            response.headers.push(("Location".into(), "/final".into()));
            response
        } else {
            Reply::json("{\"final\":true}")
        }
    });
    let general = http_transport::general().await.unwrap();
    let rtc = http_transport::rtc_control().await.unwrap();
    assert_eq!(
        general
            .get(format!("{}/jump", server.base))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let before = server.received().len();
    assert_eq!(
        rtc.get(format!("{}/jump", server.base))
            .send()
            .await
            .unwrap()
            .status(),
        302
    );
    assert_eq!(
        server.received().len(),
        before + 1,
        "RTC followed a redirect"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn general_cross_origin_redirect_does_not_forward_bearer_or_cookie() {
    let destination = Server::start(|_| Reply::json("{}"));
    let location = format!("{}/destination", destination.base);
    let origin = Server::start(move |_| {
        let mut response = Reply::json("{}");
        response.status = "302 Found";
        response.headers.push(("Location".into(), location.clone()));
        response
            .headers
            .push(("Set-Cookie".into(), "synthetic=private".into()));
        response
    });
    http_transport::general()
        .await
        .unwrap()
        .get(format!("{}/redirect", origin.base))
        .bearer_auth("synthetic-private")
        .send()
        .await
        .unwrap();
    assert_eq!(
        origin.received()[0].header("authorization"),
        Some("Bearer synthetic-private")
    );
    let target = destination.received();
    assert_eq!(target.len(), 1);
    assert_eq!(target[0].header("authorization"), None);
    assert_eq!(target[0].header("cookie"), None);
}

#[cfg(feature = "guest-rtc-pilot")]
#[tokio::test(flavor = "current_thread")]
async fn rtc_five_second_deadline_and_general_default_timeout_remain_separate() {
    let server = Server::start(|_| {
        let mut response = Reply::json("{}");
        response.delay = Duration::from_secs(6);
        response
    });
    let general = http_transport::general().await.unwrap();
    let rtc = http_transport::rtc_control().await.unwrap();
    let (a, b) = tokio::join!(
        general.get(format!("{}/general", server.base)).send(),
        rtc.get(format!("{}/rtc", server.base)).send()
    );
    assert_eq!(a.unwrap().status(), 200);
    assert!(b.unwrap_err().is_timeout());
}
