CREATE TABLE IF NOT EXISTS inquiries (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    brief TEXT NOT NULL,
    sender_hash TEXT NOT NULL,
    notification TEXT NOT NULL DEFAULT 'pending',
    resend_id TEXT
);
CREATE INDEX IF NOT EXISTS inquiries_sender_date ON inquiries(sender_hash, created_at);
