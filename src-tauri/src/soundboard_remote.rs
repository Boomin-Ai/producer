//! Loopback-only, per-launch paired control. Credentials never appear in logs.
use crate::soundboard::{self, Request};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let pairing = match soundboard::controller_pairing(&app) {
            Ok(p) => p,
            Err(_) => return,
        };
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", pairing.port)).await {
            Ok(l) => l,
            Err(_) => return,
        };
        let token = pairing.token.clone();
        let _ = soundboard::REMOTE.set(pairing);
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                break;
            };
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let mut config = WebSocketConfig::default();
                config.max_message_size = Some(65536);
                config.max_frame_size = Some(65536);
                let Ok(Ok(mut ws)) = tokio::time::timeout(
                    Duration::from_secs(5),
                    accept_async_with_config(tcp, Some(config)),
                )
                .await
                else {
                    return;
                };
                let Ok(Some(Ok(msg))) =
                    tokio::time::timeout(Duration::from_secs(5), ws.next()).await
                else {
                    return;
                };
                let Ok(auth) = serde_json::from_str::<serde_json::Value>(&msg.to_string()) else {
                    return;
                };
                if auth.get("token").and_then(|s| s.as_str()) != Some(token.as_str()) {
                    let _ = ws.close(None).await;
                    return;
                }
                if ws
                    .send(Message::Text("{\"type\":\"paired\",\"version\":1}".into()))
                    .await
                    .is_err()
                {
                    return;
                }
                let mut tick = tokio::time::interval(Duration::from_millis(300));
                let mut last = String::new();
                let (reply_tx, mut reply_rx) = tokio::sync::mpsc::channel::<serde_json::Value>(16);
                let commands = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
                loop {
                    tokio::select! {
                    msg=ws.next()=>{let Some(Ok(msg))=msg else{break};if msg.is_close(){break}if !msg.is_text(){continue}
                    let Ok(v)=serde_json::from_str::<serde_json::Value>(&msg.to_string())else{continue};let request_id=v.get("requestId").cloned().unwrap_or_default();let h=app.clone();
                    let permit=if v.get("action").and_then(|a|a.as_str())==Some("stop_all"){None}else{match commands.clone().try_acquire_owned(){Ok(p)=>Some(p),Err(_)=>{let reply=serde_json::json!({"type":"reply","requestId":request_id,"ok":false,"error":"Controller is busy"});if ws.send(Message::Text(reply.to_string())).await.is_err(){break}continue}}};
                    let response=reply_tx.clone();tauri::async_runtime::spawn(async move{let _permit=permit;
                    let result=tauri::async_runtime::spawn_blocking(move||{if v.get("action").and_then(|x|x.as_str())==Some("list"){let room=soundboard::ACTIVE.lock().map_err(|e|e.to_string())?.clone().ok_or("Open a Producer room first")?;let library=soundboard::remote_library(&h,&room)?;return Ok(serde_json::json!({"room":room,"pads":library.board.pads}));}let r:Request=serde_json::from_value(v).map_err(|e|e.to_string())?;serde_json::to_value(soundboard::execute(&h,r)?).map_err(|e|e.to_string())}).await;
                    let reply=match result{Ok(Ok(data))=>serde_json::json!({"type":"reply","requestId":request_id,"ok":true,"data":data}),Ok(Err(e))=>serde_json::json!({"type":"reply","requestId":request_id,"ok":false,"error":e}),Err(_)=>serde_json::json!({"type":"reply","requestId":request_id,"ok":false,"error":"Controller task failed"})};
                    let _=response.send(reply).await;});
                    },
                    Some(reply)=reply_rx.recv()=>{if ws.send(Message::Text(reply.to_string())).await.is_err(){break}},
                    _=tick.tick()=>{let room=soundboard::ACTIVE.lock().ok().and_then(|r|r.clone());let Some(room)=room else{if last!="idle"{last="idle".into();if ws.send(Message::Text("{\"type\":\"status\",\"data\":null}".into())).await.is_err(){break}}continue};let h=app.clone();let s=tauri::async_runtime::spawn_blocking(move||soundboard::execute(&h,Request{room,action:"status".into(),id:String::new(),value:None})).await;if let Ok(Ok(s))=s{let text=serde_json::json!({"type":"status","data":s}).to_string();if text!=last{last=text.clone();if ws.send(Message::Text(text)).await.is_err(){break}}}}
                    }
                }
            });
        }
    });
}
