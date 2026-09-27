-- Extensão aditiva para vendas históricas da Saurus e detalhamento das vendas do PDV.
-- Não altera o contrato de POST /api/v1/sales nem recria vendas já registradas.
ALTER TABLE sales ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'POS';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS external_sale_id text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS external_store_id text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS external_register_number text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS source_status text;
ALTER TABLE sales ALTER COLUMN register_id DROP NOT NULL;
ALTER TABLE sales ALTER COLUMN unit_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_source_external ON sales(source,external_sale_id) WHERE external_sale_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_source_register ON sales(source,external_store_id,external_register_number);

ALTER TABLE sale_items ALTER COLUMN quantity TYPE numeric(14,4);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS external_item_id text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS external_product_id text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS product_code text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_of_measure text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS source_unit_price numeric(14,4);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS source_data jsonb;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS external_payment_id text;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS source_data jsonb;

CREATE TABLE IF NOT EXISTS sale_installments (
  sale_id bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  external_id text,
  external_payment_id text,
  due_date date,
  amount_cents bigint CHECK(amount_cents >= 0),
  paid_cents bigint CHECK(paid_cents >= 0),
  status text,
  source_data jsonb,
  PRIMARY KEY(sale_id,line_number)
);
CREATE TABLE IF NOT EXISTS sale_tef (
  sale_id bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  external_id text,
  external_payment_id text,
  transaction_id text,
  authorization_code text,
  nsu text,
  control_code text,
  status text,
  transaction_type text,
  occurred_at timestamptz,
  PRIMARY KEY(sale_id,line_number)
);

-- O número do caixa na Saurus não é, por si só, a sigla da unidade Facinho.
CREATE TABLE IF NOT EXISTS saurus_register_mappings (
  external_store_id text NOT NULL,
  external_register_number text NOT NULL,
  unit_id bigint REFERENCES units(id) ON DELETE SET NULL,
  register_id bigint REFERENCES registers(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(external_store_id,external_register_number)
);
INSERT INTO saurus_register_mappings(external_store_id,external_register_number) VALUES
  ('3','3'),('6','6'),('6','7'),('6','8'),('6','9'),('6','10'),('6','11'),
  ('6','12'),('6','13'),('6','14'),('6','15'),('6','16'),('6','17'),('6','18'),('6','19')
ON CONFLICT DO NOTHING;
