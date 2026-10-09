-- Independent limits for the two central areas. Rotation fallback is part of the API contract.
ALTER TABLE home_banner_settings ADD COLUMN IF NOT EXISTS center_upper_count integer NOT NULL DEFAULT 3 CHECK (center_upper_count BETWEEN 1 AND 20);
ALTER TABLE home_banner_settings ADD COLUMN IF NOT EXISTS center_lower_count integer NOT NULL DEFAULT 3 CHECK (center_lower_count BETWEEN 1 AND 20);
