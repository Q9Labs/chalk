defmodule ChalkSync.Presenting.Statements do
  @moduledoc false
  # SQL for the presenting authority lives apart from the command flow so the
  # repository stays small enough to read as one transaction shape.

  def state_sql,
    do:
      "select revision from sync_presenting_states where tenant_id = $1 and space_id = $2 and episode_id = $3"

  def lock_state_sql, do: state_sql() <> " for update"

  def ensure_state_sql,
    do:
      "insert into sync_presenting_states (tenant_id, space_id, episode_id) values ($1, $2, $3) on conflict do nothing"

  def update_revision_sql,
    do:
      "update sync_presenting_states set revision = $4 where tenant_id = $1 and space_id = $2 and episode_id = $3"

  def delete_documents_sql,
    do:
      "delete from sync_presenting_documents where tenant_id = $1 and space_id = $2 and episode_id = $3"

  def documents_sql do
    """
    select document_id, presenter_id, presenter_generation, page, zoom, started_at_ms
    from sync_presenting_documents
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    order by position
    """
  end

  def insert_document_sql do
    """
    insert into sync_presenting_documents
      (tenant_id, space_id, episode_id, document_id, presenter_id, presenter_generation, position, page, zoom, started_at_ms)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    """
  end

  def lock_episode_sql do
    """
    select status from episodes
    where tenant_id = $1 and space_id = $2 and id = $3
    for no key update
    """
  end

  def lock_participant_sql do
    """
    select capabilities from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status = 'active'
    for no key update
    """
  end

  def actor_sql do
    """
    select capabilities from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4 and generation = $5 and status = 'active'
    """
  end

  def receipt_sql do
    """
    select fingerprint, revision from sync_presenting_receipts
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and actor_id = $4 and actor_generation = $5 and operation_id = $6
    """
  end

  def insert_receipt_sql do
    """
    insert into sync_presenting_receipts
      (tenant_id, space_id, episode_id, actor_id, actor_generation, operation_id, fingerprint, revision, expires_at_ms)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    """
  end
end
