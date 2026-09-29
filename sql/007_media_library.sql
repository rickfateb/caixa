-- Arquivos persistentes no PostgreSQL exclusivo do Portal Caixa.
CREATE TABLE IF NOT EXISTS media_assets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PRODUCT','CATEGORY_BANNER','OTHER')),
  original_name text NOT NULL DEFAULT '',
  original_data bytea,
  original_mime text,
  data bytea NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png')),
  width integer NOT NULL, height integer NOT NULL,
  bytes integer NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('UPLOADED','OPEN_FOOD_FACTS','GENERATED')),
  source_url text, attribution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE categories ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
INSERT INTO categories(name)
  SELECT DISTINCT trim(category) FROM products WHERE nullif(trim(category),'') IS NOT NULL
  ON CONFLICT(name) DO NOTHING;
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS asset_id bigint REFERENCES media_assets(id);
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS barcode text;
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'URL';
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'APPROVED';
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS category_banners (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id bigint NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  asset_id bigint NOT NULL REFERENCES media_assets(id),
  title text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT false, is_primary boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  banner_type text NOT NULL DEFAULT 'STANDARD', source_type text NOT NULL DEFAULT 'UPLOADED',
  starts_at timestamptz, ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_primary OR active),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_primary_banner_per_category ON category_banners(category_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS category_banners_order ON category_banners(category_id,active,display_order,id);
CREATE TABLE IF NOT EXISTS media_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_type text NOT NULL, entity_type text NOT NULL, entity_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', message text NOT NULL DEFAULT '',
  started_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE media_jobs ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
UPDATE media_jobs SET status='PENDING',available_at=now()+interval '10 minutes',started_at=NULL,
  finished_at=NULL WHERE status='ERROR' AND message IN ('IMAGE_SEARCH_FAILED','IMAGE_SOURCE_RATE_LIMITED');
-- Backfill idempotente: uma tentativa por registro existente; erros podem ser reenfileirados pelo portal.
INSERT INTO media_jobs(job_type,entity_type,entity_id)
  SELECT 'GENERATE_BANNERS','CATEGORY',c.id FROM categories c
  WHERE c.active AND NOT EXISTS(SELECT 1 FROM category_banners b WHERE b.category_id=c.id)
    AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.entity_type='CATEGORY' AND j.entity_id=c.id);
INSERT INTO media_jobs(job_type,entity_type,entity_id)
  SELECT 'CAPTURE_PRODUCTS','PRODUCT',p.id FROM products p
  WHERE p.active AND NOT EXISTS(SELECT 1 FROM product_images i WHERE i.product_id=p.id AND i.active)
    AND NOT EXISTS(SELECT 1 FROM media_jobs j WHERE j.entity_type='PRODUCT' AND j.entity_id=p.id);
