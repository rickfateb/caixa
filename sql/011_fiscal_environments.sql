-- Routing intent supports both environments; fiscal emitters/documents remain homologation-only.
CREATE TABLE IF NOT EXISTS fiscal_environment_policy (
  id integer PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
  config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
  updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fiscal_environment_policy(id,config,updated_by)
  VALUES(1,'{"defaultEnvironment":2,"registerEnvironments":{},"schedules":[]}','MIGRATION')
  ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS fiscal_sale_environments (
  sale_id bigint PRIMARY KEY REFERENCES sales(id),
  environment integer NOT NULL CHECK(environment IN(1,2)),
  policy_revision bigint NOT NULL CHECK(policy_revision>=0), decision jsonb NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now(),
  CHECK(jsonb_typeof(decision)='object' AND decision ? 'environment' AND
    jsonb_typeof(decision->'environment')='number' AND (decision->>'environment')::integer=environment)
);
-- Preserve the environment of documents prepared before policies existed.
INSERT INTO fiscal_sale_environments(sale_id,environment,policy_revision,decision,selected_at)
  SELECT sale_id,2,0,jsonb_build_object('environment',2,'source','EXISTING_DOCUMENT',
    'policyRevision','0','timeZone','America/Sao_Paulo','selectedAt',created_at),created_at
  FROM fiscal_documents WHERE environment=2 ON CONFLICT DO NOTHING;
