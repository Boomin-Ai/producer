-- Managed data connections. Provider keys remain encrypted on the workspace server.
CREATE TABLE IF NOT EXISTS data_integrations (
 id TEXT PRIMARY KEY,
 config TEXT NOT NULL,
 secret_enc TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','ready','error')),
 error TEXT NOT NULL DEFAULT '',
 tested_at INTEGER,
 last_request_at INTEGER NOT NULL DEFAULT 0,
 last_result TEXT,
 last_result_at INTEGER,
 updated_at INTEGER NOT NULL
);
