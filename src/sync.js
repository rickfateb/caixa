// Publica a mudança para os caixas. A revisão é apenas um sinal: o app baixa
// catálogo/configuração, salva localmente e só então confirma via sync-ack.
export async function publishSyncRevision(client,{actor='SYSTEM_MEDIA',minimumAgeSeconds=0,unitId=null}={}){
  const {rows}=await client.query(`INSERT INTO unit_sync_state(unit_id,revision,requested_by)
    SELECT id,2,$1 FROM units WHERE active=true AND ($3::bigint IS NULL OR id=$3)
    ON CONFLICT(unit_id) DO UPDATE SET revision=unit_sync_state.revision+1,
      requested_at=now(),requested_by=excluded.requested_by
    WHERE unit_sync_state.requested_at <= now()-($2::integer * interval '1 second')
    RETURNING unit_id,revision`,[actor,minimumAgeSeconds,unitId]);
  return rows;
}
