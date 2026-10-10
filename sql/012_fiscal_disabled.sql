-- Disabled (0) is an automatic-issuance mode, never an XML environment.
ALTER TABLE fiscal_sale_environments DROP CONSTRAINT IF EXISTS fiscal_sale_environments_environment_check;
ALTER TABLE fiscal_sale_environments ADD CONSTRAINT fiscal_sale_environments_environment_check
  CHECK(environment IN(0,1,2));

-- Keep the original automatic decision unchanged. A manual request is separate,
-- unique per sale, and is created only by an authenticated administrator's action.
CREATE TABLE IF NOT EXISTS fiscal_manual_requests (
  sale_id bigint PRIMARY KEY REFERENCES fiscal_sale_environments(sale_id),
  environment integer NOT NULL CHECK(environment IN(1,2)),
  requested_by text NOT NULL, requested_at timestamptz NOT NULL DEFAULT now()
);
