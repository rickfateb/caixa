-- Banners da tela inicial: duas faixas independentes e rotação configurável.
ALTER TABLE banners ADD COLUMN IF NOT EXISTS position text NOT NULL DEFAULT 'UPPER';
ALTER TABLE banners DROP CONSTRAINT IF EXISTS banners_position_check;
ALTER TABLE banners ADD CONSTRAINT banners_position_check CHECK (position IN ('UPPER','LOWER','CENTER_UPPER','CENTER_LOWER'));
CREATE INDEX IF NOT EXISTS idx_banners_position_active ON banners(position,active,sort_order,id);

CREATE TABLE IF NOT EXISTS home_banner_settings (
  id integer PRIMARY KEY CHECK (id=1),
  upper_count integer NOT NULL DEFAULT 3 CHECK (upper_count BETWEEN 1 AND 20),
  lower_count integer NOT NULL DEFAULT 3 CHECK (lower_count BETWEEN 1 AND 20),
  transition_seconds integer NOT NULL DEFAULT 8 CHECK (transition_seconds BETWEEN 2 AND 120),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO home_banner_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
