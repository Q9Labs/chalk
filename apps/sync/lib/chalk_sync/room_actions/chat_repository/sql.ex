defmodule ChalkSync.RoomActions.ChatRepository.SQL do
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
      session.status,
      participant.generation,
      participant.status,
      participant.name,
      participant.role,
      session.room_action_role_capabilities
    from room_sessions session
    join participants participant
      on participant.tenant_id = session.tenant_id
      and participant.room_id = session.room_id
      and participant.session_id = session.id
    where session.tenant_id = $1
      and session.room_id = $2
      and session.id = $3
      and participant.id = $4
    for share of session, participant
    """
  end

  def insert_stream do
    """
    insert into sync_chat_streams (tenant_id, room_id, session_id)
    values ($1, $2, $3)
    on conflict (tenant_id, session_id) do nothing
    """
  end

  def lock_stream do
    """
    select head_sequence, retained_floor_sequence, message_count, message_bytes
    from sync_chat_streams
    where tenant_id = $1 and room_id = $2 and session_id = $3
    for update
    """
  end

  def lock_stream_for_read do
    """
    select head_sequence, retained_floor_sequence
    from sync_chat_streams
    where tenant_id = $1 and room_id = $2 and session_id = $3
    for share
    """
  end

  def list_participant_capabilities do
    """
    select participant.id, participant.role, session.room_action_role_capabilities
    from participants participant
    join room_sessions session
      on session.tenant_id = participant.tenant_id
      and session.room_id = participant.room_id
      and session.id = participant.session_id
    where participant.tenant_id = $1
      and participant.room_id = $2
      and participant.session_id = $3
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
      message.participant_session_id,
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
      and attachment.session_id = message.session_id
      and attachment.message_sequence = message.sequence
    where message.tenant_id = $1
      and message.room_id = $2
      and message.session_id = $3
      and message.participant_session_id = $4
      and message.participant_session_generation = $5
      and message.client_message_id = $6
    group by message.tenant_id, message.session_id, message.sequence
    """
  end

  def reserve_message do
    """
    update sync_chat_streams
    set
      head_sequence = $4,
      retained_floor_sequence = coalesce(retained_floor_sequence, $4),
      message_count = message_count + 1,
      message_bytes = message_bytes + $5,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and head_sequence = $4 - 1
      and message_count < 250000
      and message_bytes + $5 <= 2147483648
    returning head_sequence
    """
  end

  def insert_message do
    """
    insert into sync_chat_messages (
      tenant_id,
      room_id,
      session_id,
      sequence,
      message_id,
      participant_session_id,
      participant_session_generation,
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
    where tenant_id = $1 and room_id = $2 and session_id = $3
    """
  end

  def read_newer_page do
    """
    select
      message.message_id,
      message.client_message_id,
      message.sequence,
      message.participant_session_id,
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
      and attachment.session_id = message.session_id
      and attachment.message_sequence = message.sequence
    where message.tenant_id = $1
      and message.room_id = $2
      and message.session_id = $3
      and message.sequence > $4
      and message.sequence <= $5
    group by message.tenant_id, message.session_id, message.sequence
    order by message.sequence asc
    limit $6
    """
  end

  def read_older_page do
    """
    select
      message.message_id,
      message.client_message_id,
      message.sequence,
      message.participant_session_id,
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
      and attachment.session_id = message.session_id
      and attachment.message_sequence = message.sequence
    where message.tenant_id = $1
      and message.room_id = $2
      and message.session_id = $3
      and message.sequence < $4
      and message.sequence >= $5
    group by message.tenant_id, message.session_id, message.sequence
    order by message.sequence desc
    limit $6
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
      participant_session_id,
      participant_session_generation
    from sync_chat_attachments
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
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
      and room_id = $2
      and session_id = $3
      and attachment_id = $7
      and status = 'ready'
      and participant_session_id = $8
      and participant_session_generation = $9
      and expires_at > now()
      and cleanup_claim_token is null
    returning attachment_id
    """
  end

  def list_read_receipts do
    """
    select
      receipt.participant_session_id,
      receipt.participant_session_generation,
      receipt.sequence,
      receipt.read_at
    from sync_chat_read_receipts receipt
    join participants participant
      on participant.tenant_id = receipt.tenant_id
      and participant.room_id = receipt.room_id
      and participant.session_id = receipt.session_id
      and participant.id = receipt.participant_session_id
      and participant.generation = receipt.participant_session_generation
    where receipt.tenant_id = $1
      and receipt.room_id = $2
      and receipt.session_id = $3
      and participant.status = 'active'
    order by
      receipt.read_at desc,
      receipt.participant_session_id,
      receipt.participant_session_generation
    limit 500
    """
  end

  def upsert_read_receipt do
    """
    insert into sync_chat_read_receipts (
      tenant_id,
      room_id,
      session_id,
      participant_session_id,
      participant_session_generation,
      sequence,
      read_at
    ) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (
      tenant_id,
      session_id,
      participant_session_id,
      participant_session_generation
    ) do update set
      sequence = excluded.sequence,
      read_at = excluded.read_at,
      updated_at = now()
    where sync_chat_read_receipts.sequence < excluded.sequence
    returning participant_session_id, participant_session_generation, sequence, read_at
    """
  end

  def read_participant_receipt do
    """
    select participant_session_id, participant_session_generation, sequence, read_at
    from sync_chat_read_receipts
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and participant_session_id = $4
      and participant_session_generation = $5
    """
  end
end
