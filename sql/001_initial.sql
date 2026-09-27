-- Banco exclusivo do portal Facinho Caixa. Valores monetários em centavos.
CREATE TABLE IF NOT EXISTS users (
  email text PRIMARY KEY, name text NOT NULL DEFAULT '', role text NOT NULL CHECK(role IN ('ADMINISTRADOR','SUPERVISOR','COLABORADOR')),
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS units (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, external_id text UNIQUE,
  name text NOT NULL, acronym text NOT NULL UNIQUE, document text,
  active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id text UNIQUE, status text NOT NULL DEFAULT 'ATIVO', item_type text, code text,
  description text NOT NULL, registered_description text, ncm text,
  category text, subcategory text, brand text, unit_of_measure text,
  purchase_cost_cents bigint CHECK(purchase_cost_cents >= 0), cost_cents bigint CHECK(cost_cents >= 0),
  source_updated_at timestamptz, active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS product_barcodes (
  barcode text PRIMARY KEY, product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS unit_products (
  unit_id bigint NOT NULL REFERENCES units(id), product_id bigint NOT NULL REFERENCES products(id),
  sale_price_cents bigint NOT NULL CHECK(sale_price_cents >= 0), active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(unit_id, product_id)
);
CREATE TABLE IF NOT EXISTS registers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, unit_id bigint NOT NULL REFERENCES units(id),
  name text NOT NULL, external_number text, token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(unit_id, name)
);
CREATE TABLE IF NOT EXISTS unit_settings (
  unit_id bigint PRIMARY KEY REFERENCES units(id), settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  register_id bigint NOT NULL REFERENCES registers(id), unit_id bigint NOT NULL REFERENCES units(id),
  client_sale_id text NOT NULL, occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK(status IN ('APPROVED','CANCELLED')),
  total_cents bigint NOT NULL CHECK(total_cents >= 0),
  payload_hash text NOT NULL, raw_payload jsonb NOT NULL,
  UNIQUE(register_id,client_sale_id)
);
CREATE TABLE IF NOT EXISTS sale_items (
  sale_id bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE, line_number integer NOT NULL,
  product_id bigint REFERENCES products(id), barcode text,
  description text NOT NULL, quantity numeric(12,3) NOT NULL CHECK(quantity > 0),
  unit_price_cents bigint NOT NULL CHECK(unit_price_cents >= 0), total_cents bigint NOT NULL CHECK(total_cents >= 0),
  PRIMARY KEY(sale_id,line_number)
);
CREATE TABLE IF NOT EXISTS sale_payments (
  sale_id bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE, line_number integer NOT NULL,
  method text NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents >= 0),
  provider_reference text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY(sale_id,line_number)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL, action text NOT NULL,
  entity text NOT NULL, entity_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_updated ON products(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_unit_products_updated ON unit_products(unit_id,updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_unit_time ON sales(unit_id,occurred_at DESC);
