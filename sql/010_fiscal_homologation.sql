-- Homologation only. No historical sales are queued by this migration.
CREATE TABLE IF NOT EXISTS fiscal_issuers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id bigint NOT NULL UNIQUE REFERENCES units(id),
  cnpj text NOT NULL, environment integer NOT NULL DEFAULT 2 CHECK(environment=2),
  series integer NOT NULL CHECK(series BETWEEN 1 AND 889),
  next_number integer NOT NULL CHECK(next_number BETWEEN 1 AND 1000000000),
  config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false,
  reviewed_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cnpj,environment,series)
);
CREATE TABLE IF NOT EXISTS fiscal_product_profiles (
  issuer_id bigint NOT NULL REFERENCES fiscal_issuers(id),
  product_id bigint NOT NULL REFERENCES products(id),
  profile jsonb NOT NULL, reviewed_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer_id,product_id)
);
CREATE TABLE IF NOT EXISTS fiscal_documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id bigint NOT NULL REFERENCES sales(id), issuer_id bigint NOT NULL REFERENCES fiscal_issuers(id),
  environment integer NOT NULL DEFAULT 2 CHECK(environment=2), model integer NOT NULL DEFAULT 65 CHECK(model=65),
  series integer NOT NULL, number integer, access_key text UNIQUE,
  status text NOT NULL CHECK(status IN ('BLOCKED','PENDING','SIGNED','SUBMITTING','UNKNOWN','AUTHORIZED','REJECTED','MANUAL')),
  snapshot jsonb, snapshot_hash text, ini_payload text, signed_xml text, authorized_xml text,
  protocol text, sefaz_code text, sefaz_message text, qr_code text, danfe_pdf bytea,
  last_error text, attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sale_id,environment), UNIQUE(issuer_id,environment,series,number)
);
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_queue ON fiscal_documents(retry_at,id)
  WHERE status IN ('PENDING','SIGNED','SUBMITTING','UNKNOWN','AUTHORIZED');
CREATE INDEX IF NOT EXISTS idx_fiscal_documents_sale ON fiscal_documents(sale_id);
