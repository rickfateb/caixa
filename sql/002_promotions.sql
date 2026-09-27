-- Migration safe to rerun at startup; project-specific database only.
ALTER TABLE products ADD COLUMN IF NOT EXISTS default_sale_price_cents bigint CHECK(default_sale_price_cents >= 0);
CREATE TABLE IF NOT EXISTS promotions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK(type IN ('PRICE','PERCENT','BUY_N_PAY_M','SECOND_UNIT_PRICE')),
  scope text NOT NULL CHECK(scope IN ('ALL','PRODUCTS')),
  priority integer NOT NULL DEFAULT 0 CHECK(priority BETWEEN -1000 AND 1000),
  price_cents bigint CHECK(price_cents >= 0),
  percent_off numeric(5,2) CHECK(percent_off > 0 AND percent_off <= 100),
  buy_quantity integer CHECK(buy_quantity BETWEEN 2 AND 100),
  pay_quantity integer CHECK(pay_quantity >= 1),
  second_unit_price_cents bigint CHECK(second_unit_price_cents >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK(ends_at > starts_at),
  weekdays smallint[] CHECK(weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  local_start time,
  local_end time,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((weekdays IS NULL AND local_start IS NULL AND local_end IS NULL)
    OR (cardinality(weekdays) > 0 AND local_start IS NOT NULL AND local_end IS NOT NULL AND local_end > local_start)),
  CHECK ((type='PRICE' AND price_cents IS NOT NULL) OR type<>'PRICE'),
  CHECK ((type='PERCENT' AND percent_off IS NOT NULL) OR type<>'PERCENT'),
  CHECK ((type='BUY_N_PAY_M' AND buy_quantity IS NOT NULL AND pay_quantity < buy_quantity) OR type<>'BUY_N_PAY_M'),
  CHECK ((type='SECOND_UNIT_PRICE' AND second_unit_price_cents IS NOT NULL) OR type<>'SECOND_UNIT_PRICE')
);
CREATE TABLE IF NOT EXISTS promotion_products (
  promotion_id bigint NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id), PRIMARY KEY(promotion_id,product_id)
);
CREATE TABLE IF NOT EXISTS promotion_units (
  promotion_id bigint NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  unit_id bigint NOT NULL REFERENCES units(id), PRIMARY KEY(promotion_id,unit_id)
);
CREATE INDEX IF NOT EXISTS idx_promotions_window ON promotions(active,starts_at,ends_at);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount_cents bigint NOT NULL DEFAULT 0 CHECK(discount_cents >= 0);
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS promotion_id bigint REFERENCES promotions(id) ON DELETE SET NULL;
