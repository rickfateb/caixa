-- Uma versão por unidade. Cada caixa confirma quando já armazenou o catálogo e a configuração.
CREATE TABLE IF NOT EXISTS unit_sync_state (
  unit_id bigint PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by text NOT NULL DEFAULT 'SYSTEM'
);
CREATE TABLE IF NOT EXISTS register_sync_status (
  register_id bigint PRIMARY KEY REFERENCES registers(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK(revision > 0),
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO unit_sync_state(unit_id) SELECT id FROM units ON CONFLICT(unit_id) DO NOTHING;
