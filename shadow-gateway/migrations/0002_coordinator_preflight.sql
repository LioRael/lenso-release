CREATE TABLE preflight_proofs (
  proof_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  token TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE UNIQUE INDEX preflight_proofs_event ON preflight_proofs(event_id, binding_digest);
