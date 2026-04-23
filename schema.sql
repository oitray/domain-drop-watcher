CREATE TABLE IF NOT EXISTS domains (
  fqdn TEXT PRIMARY KEY,
  added_at INTEGER NOT NULL,
  cadence_minutes INTEGER NOT NULL,
  phase_offset_minutes INTEGER NOT NULL,
  next_due_at INTEGER NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  last_status TEXT,
  last_status_changed_at INTEGER,
  last_checked_at INTEGER,
  pending_confirm_status TEXT,
  pending_confirm_count INTEGER DEFAULT 0,
  notify_on TEXT NOT NULL,
  label TEXT,
  tld_supported INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_domains_due ON domains(next_due_at) WHERE paused = 0 AND tld_supported = 1;

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  target TEXT NOT NULL,
  label TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  last_delivery_result TEXT,
  last_delivery_at INTEGER
);

CREATE TABLE IF NOT EXISTS domain_channels (
  fqdn TEXT NOT NULL REFERENCES domains(fqdn) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  PRIMARY KEY (fqdn, channel_id)
);

CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL);

INSERT OR IGNORE INTO config (k, v) VALUES ('default_cadence_minutes', '5');
INSERT OR IGNORE INTO config (k, v) VALUES ('global_paused', '0');
INSERT OR IGNORE INTO config (k, v) VALUES ('version', '1');
