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
      message_id,
      client_message_id,
      sequence,
      participant_session_id,
      display_name,
      message_text,
      created_at,
      request_fingerprint
    from sync_chat_messages
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and participant_session_id = $4
      and participant_session_generation = $5
      and client_message_id = $6
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
      message_id,
      client_message_id,
      sequence,
      participant_session_id,
      display_name,
      message_text,
      created_at
    from sync_chat_messages
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and sequence > $4
      and sequence <= $5
    order by sequence asc
    limit $6
    """
  end

  def read_older_page do
    """
    select
      message_id,
      client_message_id,
      sequence,
      participant_session_id,
      display_name,
      message_text,
      created_at
    from sync_chat_messages
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and sequence < $4
      and sequence >= $5
    order by sequence desc
    limit $6
    """
  end
end
