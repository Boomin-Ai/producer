//! The submit pipeline: drain pending outbox targets to their
//! endpoints. Called after intent creation, and once at startup to
//! resume anything a crash left unacknowledged.

use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use crate::client::{ProducerClient, SubmitOutcome};
use crate::error::EngineResult;
use crate::{outbox, vault};

#[derive(Debug, Serialize)]
pub struct TargetResult {
    pub endpoint_id: String,
    pub channel_id: String,
    pub accepted: bool,
    pub replayed: bool,
    pub error: Option<String>,
    pub job: Option<Value>,
}

/// Drain pending targets (optionally scoped to one intent).
/// Failures are recorded per-target and never block sibling targets.
pub async fn submit_pending(
    db: &Mutex<Connection>,
    only_intent: Option<&str>,
) -> EngineResult<Vec<TargetResult>> {
    // Snapshot pending work + endpoint base URLs under one short lock.
    let (targets, base_urls) = {
        let conn = db.lock().expect("db mutex poisoned");
        let targets = outbox::pending_targets(&conn, only_intent)?;
        let mut base_urls: HashMap<String, String> = HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT id, base_url FROM endpoints")?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (id, url) = row?;
                base_urls.insert(id, url);
            }
        }
        (targets, base_urls)
    };

    let mut results = Vec::with_capacity(targets.len());
    for t in targets {
        let outcome = match base_urls.get(&t.endpoint_id) {
            None => Err(format!("unknown endpoint {}", t.endpoint_id)),
            Some(base_url) => match vault::get_token(&t.endpoint_id) {
                Err(e) => Err(format!("no access token in keychain: {e}")),
                Ok(token) => {
                    let client = ProducerClient::new(base_url, &token);
                    match client
                        .create_post(&t.request_json, &t.idempotency_key)
                        .await
                    {
                        Ok(SubmitOutcome::Accepted { job, replayed }) => Ok((job, replayed)),
                        Ok(SubmitOutcome::IdempotencyConflict) => {
                            Err("idempotency conflict: key reused with a different payload"
                                .to_string())
                        }
                        Ok(SubmitOutcome::Rejected { message, .. }) => Err(message),
                        Err(e) => Err(e.to_string()),
                    }
                }
            },
        };

        let conn = db.lock().expect("db mutex poisoned");
        match outcome {
            Ok((job, replayed)) => {
                outbox::mark_acknowledged(&conn, &t.idempotency_key)?;
                results.push(TargetResult {
                    endpoint_id: t.endpoint_id,
                    channel_id: t.channel_id,
                    accepted: true,
                    replayed,
                    error: None,
                    job: Some(job),
                });
            }
            Err(msg) => {
                outbox::record_error(&conn, &t.idempotency_key, &msg)?;
                results.push(TargetResult {
                    endpoint_id: t.endpoint_id,
                    channel_id: t.channel_id,
                    accepted: false,
                    replayed: false,
                    error: Some(msg),
                    job: None,
                });
            }
        }
    }

    let conn = db.lock().expect("db mutex poisoned");
    outbox::cleanup_complete(&conn)?;
    Ok(results)
}
