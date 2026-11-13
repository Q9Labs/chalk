defmodule ChalkSync.Chat.Input do
  @moduledoc """
  Checks the identifiers, cursors and directions of chat frames and names a failure code for the wire.
  """

  def error_code(reason)
       when reason in [
              :capability_denied,
              :invalid_payload,
              :rate_limited,
              :overloaded,
              :episode_ended,
              :participant_stale,
              :client_message_id_conflict,
              :attachment_not_found,
              :attachment_not_ready,
              :attachment_already_claimed,
              :attachment_quota_exceeded,
              :dependency_unavailable
            ] do
    Atom.to_string(reason)
  end

  def error_code(_reason) do
    "dependency_unavailable"
  end


  def valid_chat_cursor(%{after_sequence: after_sequence, retained_floor_sequence: floor})
       when is_nil(after_sequence) or is_binary(after_sequence) do
    if is_nil(floor) or is_binary(floor) do
      :ok
    else
      {:error, :invalid_payload}
    end
  end

  def valid_chat_cursor(_cursor) do
    {:error, :invalid_payload}
  end


  def validate_operation_id(value) do
    if byte_size(value) in 16..64 do
      :ok
    else
      {:error, :invalid_payload}
    end
  end


  def normalize_direction("older") do
    :older
  end

  def normalize_direction("newer") do
    :newer
  end

  def normalize_direction(direction) when direction in [:older, :newer] do
    direction
  end

  def normalize_direction(_direction) do
    :invalid
  end
end
