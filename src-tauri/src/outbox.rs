//! Durable submission outbox (PHASE1.md §2.4).
//!
//! Invariant: once an intent is persisted, every target instruction is
//! independently reconstructable from request_json alone. The desktop
//! owns delivery of the scheduling instruction; endpoints own execution
//! of the schedule. Idempotency keys are reused verbatim on resume so
//! the server's effectively-once acceptance makes retries safe.

use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::EngineResult;

#[derive(Debug, Clone)]
pub struct NewTarget {
    pub endpoint_id: String,
    pub channel_id: String,
    /// The exact, immutable Producer API request body for this target.
    pub request_json: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TargetRow {
    pub intent_id: String,
    pub endpoint_id: String,
    pub channel_id: String,
    pub idempotency_key: String,
    pub request_json: String,
    pub status: String,
    pub last_error: Option<String>,
}

pub fn request_hash(request_json: &str) -> String {
    hex::encode(Sha256::digest(request_json.as_bytes()))
}

/// Atomically persist a fan-out intent. The caller supplies the id so
/// it can be embedded in each target's request_json (as `intent_id`)
/// before persistence. Media rule (enforced upstream): targets are only
/// built once media is a durable upload_id or stable URL — request_json
/// must already satisfy that.
pub fn create_intent(
    conn: &mut Connection,
    intent_id: &str,
    targets: &[NewTarget],
) -> EngineResult<String> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO submission_intents (id) VALUES (?1)",
        params![intent_id],
    )?;
    for t in targets {
        tx.execute(
            "INSERT INTO submission_targets
               (intent_id, endpoint_id, channel_id, idempotency_key,
                request_json, request_hash)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                intent_id,
                t.endpoint_id,
                t.channel_id,
                Uuid::new_v4().to_string(),
                t.request_json,
                request_hash(&t.request_json),
            ],
        )?;
    }
    tx.commit()?;
    Ok(intent_id.to_string())
}

pub fn pending_targets(
    conn: &Connection,
    only_intent: Option<&str>,
) -> EngineResult<Vec<TargetRow>> {
    let sql = "SELECT intent_id, endpoint_id, channel_id, idempotency_key,
                      request_json, status, last_error
               FROM submission_targets
               WHERE status = 'pending'
                 AND (?1 IS NULL OR intent_id = ?1)
               ORDER BY rowid";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(params![only_intent], |r| {
            Ok(TargetRow {
                intent_id: r.get(0)?,
                endpoint_id: r.get(1)?,
                channel_id: r.get(2)?,
                idempotency_key: r.get(3)?,
                request_json: r.get(4)?,
                status: r.get(5)?,
                last_error: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn all_targets(conn: &Connection) -> EngineResult<Vec<TargetRow>> {
    let mut stmt = conn.prepare(
        "SELECT intent_id, endpoint_id, channel_id, idempotency_key,
                request_json, status, last_error
         FROM submission_targets ORDER BY rowid",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TargetRow {
                intent_id: r.get(0)?,
                endpoint_id: r.get(1)?,
                channel_id: r.get(2)?,
                idempotency_key: r.get(3)?,
                request_json: r.get(4)?,
                status: r.get(5)?,
                last_error: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn mark_acknowledged(conn: &Connection, idempotency_key: &str) -> EngineResult<()> {
    conn.execute(
        "UPDATE submission_targets
         SET status = 'acknowledged',
             acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             last_error = NULL
         WHERE idempotency_key = ?1",
        params![idempotency_key],
    )?;
    Ok(())
}

pub fn record_error(conn: &Connection, idempotency_key: &str, error: &str) -> EngineResult<()> {
    conn.execute(
        "UPDATE submission_targets SET last_error = ?2
         WHERE idempotency_key = ?1",
        params![idempotency_key, error],
    )?;
    Ok(())
}

/// Delete intents whose every target is acknowledged.
pub fn cleanup_complete(conn: &Connection) -> EngineResult<usize> {
    let n = conn.execute(
        "DELETE FROM submission_intents
         WHERE id NOT IN (
            SELECT DISTINCT intent_id FROM submission_targets
            WHERE status = 'pending'
         )",
        [],
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn two_targets() -> Vec<NewTarget> {
        vec![
            NewTarget {
                endpoint_id: "ep-a".into(),
                channel_id: "ch-ig".into(),
                request_json: r#"{"channel_id":"ch-ig","text":"hello"}"#.into(),
            },
            NewTarget {
                endpoint_id: "ep-b".into(),
                channel_id: "ch-th".into(),
                request_json: r#"{"channel_id":"ch-th","text":"hello"}"#.into(),
            },
        ]
    }

    #[test]
    fn hash_is_deterministic() {
        assert_eq!(request_hash("abc"), request_hash("abc"));
        assert_ne!(request_hash("abc"), request_hash("abd"));
    }

    #[test]
    fn intent_survives_and_resumes_by_request_json_alone() {
        let mut conn = store::open_in_memory().unwrap();
        let intent = create_intent(&mut conn, "intent-1", &two_targets()).unwrap();

        // Crash-resume view: pending targets are fully reconstructable.
        let pending = pending_targets(&conn, None).unwrap();
        assert_eq!(pending.len(), 2);
        assert!(pending.iter().all(|t| !t.request_json.is_empty()));
        assert!(pending.iter().all(|t| !t.idempotency_key.is_empty()));

        // Keys are stable across reads (reused verbatim on retry).
        let again = pending_targets(&conn, Some(&intent)).unwrap();
        assert_eq!(pending[0].idempotency_key, again[0].idempotency_key);

        // Ack one; the intent must persist while a target is pending.
        mark_acknowledged(&conn, &pending[0].idempotency_key).unwrap();
        assert_eq!(cleanup_complete(&conn).unwrap(), 0);
        assert_eq!(pending_targets(&conn, None).unwrap().len(), 1);

        // Ack the second; now the intent is deleted (cascade clears rows).
        mark_acknowledged(&conn, &pending[1].idempotency_key).unwrap();
        assert_eq!(cleanup_complete(&conn).unwrap(), 1);
        assert_eq!(all_targets(&conn).unwrap().len(), 0);
    }

    #[test]
    fn errors_are_recorded_without_losing_pending_status() {
        let mut conn = store::open_in_memory().unwrap();
        create_intent(&mut conn, "intent-2", &two_targets()).unwrap();
        let pending = pending_targets(&conn, None).unwrap();
        record_error(&conn, &pending[0].idempotency_key, "network down").unwrap();
        let after = pending_targets(&conn, None).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].last_error.as_deref(), Some("network down"));
    }
}
