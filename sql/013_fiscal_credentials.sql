-- A1 and CSC for homologation are encrypted by the application before insertion.
-- The encryption key lives outside PostgreSQL and is shared only with the fiscal worker.
CREATE TABLE IF NOT EXISTS fiscal_credentials (
  issuer_id bigint PRIMARY KEY REFERENCES fiscal_issuers(id) ON DELETE CASCADE,
  encrypted_pfx bytea NOT NULL,
  encrypted_password bytea NOT NULL,
  encrypted_csc bytea NOT NULL,
  csc_id text NOT NULL CHECK (csc_id ~ '^[0-9]{6}$'),
  pfx_sha256 text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
