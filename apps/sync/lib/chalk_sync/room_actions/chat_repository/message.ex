defmodule ChalkSync.RoomActions.ChatRepository.Message do
  @moduledoc false

  alias ChalkSync.UUID

  def from_row([
        message_id,
        client_message_id,
        sequence,
        participant_id,
        display_name,
        text,
        created_at
      ]) do
    %{
      message_id: UUID.load!(message_id),
      client_message_id: client_message_id,
      sequence: Integer.to_string(sequence),
      participant_session_id: UUID.load!(participant_id),
      display_name: display_name,
      text: text,
      created_at: timestamp_to_iso8601(created_at)
    }
  end

  def encoded_bytes(message) do
    message
    |> wire()
    |> JSON.encode!()
    |> byte_size()
  end

  def wire(message) do
    %{
      "type" => "chat_message",
      "message_id" => message.message_id,
      "client_message_id" => message.client_message_id,
      "sequence" => message.sequence,
      "participant_session_id" => message.participant_session_id,
      "display_name" => message.display_name,
      "text" => message.text,
      "created_at" => message.created_at
    }
  end

  def iso_datetime(value) do
    {:ok, datetime, 0} = DateTime.from_iso8601(value)
    datetime
  end

  defp timestamp_to_iso8601(%DateTime{} = value) do
    value |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp timestamp_to_iso8601(%NaiveDateTime{} = value) do
    value
    |> DateTime.from_naive!("Etc/UTC")
    |> DateTime.truncate(:millisecond)
    |> DateTime.to_iso8601()
  end
end
