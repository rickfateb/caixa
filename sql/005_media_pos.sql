-- URLs de imagens hospedadas em storage persistente; nenhuma imagem é gravada no disco efêmero do serviço.
CREATE TABLE IF NOT EXISTS product_images (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url text NOT NULL,
  alt_text text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id,sort_order,id);

CREATE TABLE IF NOT EXISTS categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  image_url text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS banners (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  image_url text NOT NULL,
  target_url text,
  sort_order integer NOT NULL DEFAULT 0,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE TABLE IF NOT EXISTS banner_units (
  banner_id bigint NOT NULL REFERENCES banners(id) ON DELETE CASCADE,
  unit_id bigint NOT NULL REFERENCES units(id),
  PRIMARY KEY(banner_id,unit_id)
);

ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;
ALTER TABLE sale_tef ADD COLUMN IF NOT EXISTS simulated boolean NOT NULL DEFAULT false;
