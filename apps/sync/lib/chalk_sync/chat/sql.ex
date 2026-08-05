defmodule ChalkSync.Chat.Repository.SQL do
  @moduledoc false

  def transaction_settings do
    """
    select
      set_config('lock_timeout', '750ms', true),
      set_config('statement_timeout', '2s', true),
      set_config('synchronous_commit', 'on', true)
    """
  end

  def lock_authority do
    """
    select
      episode.status,
      participant.generation,
      participant.status,
      participant.name,
      participant.role,
      participant.capabilities
    from episodes episode
    join participants participant
      on participant.tenant_id = episode.tenant_id
      and participant.space_id = episode.space_id
      and participant.episode_id = episode.id
    where episode.tenant_id = $1
      and episode.space_id = $2
      and episode.id = $3
      and participant.id = $4
    for share of episode, participant
    """
  end

  def insert_stream do
    """
    insert into sync_chat_streams (tenant_id, space_id)
    values ($1, $2)
    on conflict (tenant_id, space_id) do nothing
    """
  end

  def lock_stream do
    """
    select head_sequence, retained_floor_sequence, message_count, message_bytes
    from sync_chat_streams
    where tenant_id = $1 and space_id = $2
    for update
    """
  end

  def lock_stream_for_read do
    """
    select head_sequence, retained_floor_sequence
    from sync_chat_streams
    where tenant_id = $1 and space_id = $2
    for share
    """
  end

  def list_participant_capabilities do
    """
    select participant.id, participant.role, participant.capabilities
    from participants participant
    join episodes episode
      on episode.tenant_id = participant.tenant_id
      and episode.space_id = participant.space_id
      and episode.id = participant.episode_id
    where participant.tenant_id = $1
      and participant.space_id = $2
      and participant.episode_id = $3
      and participant.status = 'active'
    order by participant.id
    """
  end

  def select_idempotent_message do
    """
    select
      message.message_id,
      message.client_message_id,
      message.sequence,
      message.participant_id,
      message.display_name,
      message.message_text,
      message.created_at,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'attachment_id', attachment.attachment_id,
            'file_name', attachment.original_filename,
            'mime_type', attachment.mime_type,
            'byte_length', attachment.byte_length
          ) order by attachment.message_ordinal
        ) filter (where attachment.attachment_id is not null),
        '[]'::jsonb
      ),
      message.request_fingerprint
    from sync_chat_messages message
    left join sync_chat_attachments attachment
      on attachment.tenant_id = message.tenant_id
      and attachment.space_id = message.space_id
      and attachment.message_sequence = message.sequence
    where message.tenant_id = $1
      and message.space_id = $2
      and message.participant_id = $3
      and message.participant_generation = $4
      and message.client_message_id = $5
    group by message.tenant_id, message.space_id, message.sequence
    """
  end

  def reserve_message do
    """
    update sync_chat_streams
    set
      head_sequence = $3,
      retained_floor_sequence = coalesce(retained_floor_sequence, $3),
      message_count = message_count + 1,
      message_bytes = message_bytes + $4,
      updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and head_sequence = $3 - 1
      and message_count < 250000
      and message_bytes + $4 <= 2147483648
    returning head_sequence
    """
  end

  def insert_message do
    """
    insert into sync_chat_messages (
      tenant_id,
      space_id,
      episode_id,
      sequence,
      message_id,
      participant_id,
      participant_generation,
      client_message_id,
      request_fingerprint,
      display_name,
      message_text,
      encoded_bytes,
      created_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    """
  end

  def read_head do
    """
    select head_sequence, retained_floor_sequence
    from sync_chat_streams
    where tenant_id = $1 and space_id = $2
    """
  end

  def read_newer_page do
    """
    select
      message.message_id,
      message.client_message_id,
      message.sequence,
      message.participant_id,
      message.display_name,
      message.message_text,
      message.created_at,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'attachment_id', attachment.attachment_id,
            'file_name', attachment.original_filename,
            'mime_type', attachment.mime_type,
            'byte_length', attachment.byte_length
          ) order by attachment.message_ordinal
        ) filter (where attachment.attachment_id is not null),
        '[]'::jsonb
      )
    from sync_chat_messages message
    left join sync_chat_attachments attachment
      on attachment.tenant_id = message.tenant_id
      and attachment.space_id = message.space_id
      and attachment.message_sequence = message.sequence
    where message.tenant_id = $1
      and message.space_id = $2
      and message.sequence > $3
      and message.sequence <= $4
    group by message.tenant_id, message.space_id, message.sequence
    order by message.sequence asc
    limit $5
    """
  end

  def read_older_page do
    """
    select
      message.message_id,
      message.client_message_id,
      message.sequence,
      message.participant_id,
      message.display_name,
      message.message_text,
      message.created_at,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'attachment_id', attachment.attachment_id,
            'file_name', attachment.original_filename,
            'mime_type', attachment.mime_type,
            'byte_length', attachment.byte_length
          ) order by attachment.message_ordinal
        ) filter (where attachment.attachment_id is not null),
        '[]'::jsonb
      )
    from sync_chat_messages message
    left join sync_chat_attachments attachment
      on attachment.tenant_id = message.tenant_id
      and attachment.space_id = message.space_id
      and attachment.message_sequence = message.sequence
    where message.tenant_id = $1
      and message.space_id = $2
      and message.sequence < $3
      and message.sequence >= $4
    group by message.tenant_id, message.space_id, message.sequence
    order by message.sequence desc
    limit $5
    """
  end

  def lock_attachments do
    """
    select
      attachment_id,
      original_filename,
      mime_type,
      byte_length,
      status,
      participant_id,
      participant_generation
    from sync_chat_attachments
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and attachment_id = any($4::uuid[])
      and expires_at > now()
      and cleanup_claim_token is null
    order by array_position($4::uuid[], attachment_id)
    for update
    """
  end

  def attach_message_files do
    """
    update sync_chat_attachments
    set
      status = 'attached',
      message_sequence = $4,
      message_ordinal = $5,
      attached_at = $6,
      updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and attachment_id = $7
      and status = 'ready'
      and participant_id = $8
      and participant_generation = $9
      and expires_at > now()
      and cleanup_claim_token is null
    returning attachment_id
    """
  end

  def list_read_receipts do
    """
    select
      receipt.participant_id,
      receipt.participant_generation,
      receipt.sequence,
      receipt.read_at
    from sync_chat_read_receipts receipt
    join participants participant
      on participant.tenant_id = receipt.tenant_id
      and participant.space_id = receipt.space_id
      and participant.episode_id = receipt.episode_id
      and participant.id = receipt.participant_id
      and participant.generation = receipt.participant_generation
    where receipt.tenant_id = $1
      and receipt.space_id = $2
      and receipt.episode_id = $3
      and participant.status = 'active'
    order by
      receipt.read_at desc,
      receipt.participant_id,
      receipt.participant_generation
    limit 500
    """
  end

  def upsert_read_receipt do
    """
    insert into sync_chat_read_receipts (
      tenant_id,
      space_id,
      episode_id,
      participant_id,
      participant_generation,
      sequence,
      read_at
    ) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (tenant_id, space_id, participant_id, participant_generation)
    do update set
      sequence = excluded.sequence,
      read_at = excluded.read_at,
      updated_at = now()
    where sync_chat_read_receipts.sequence < excluded.sequence
    returning participant_id, participant_generation, sequence, read_at
    """
  end

  def read_participant_receipt do
    """
    select participant_id, participant_generation, sequence, read_at
    from sync_chat_read_receipts
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and participant_id = $4
      and participant_generation = $5
    """
  end
end
