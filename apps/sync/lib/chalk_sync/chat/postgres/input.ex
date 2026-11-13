defmodule ChalkSync.Chat.Postgres.Input do
  @moduledoc """
  Validates a chat append request and fingerprints it for idempotency.
  """

  alias ChalkSync.UUID

  def validate_input(%{
         client_message_id: client_message_id,
         text: text,
         attachment_ids: attachment_ids
       }) do
    with :ok <- validate_client_message_id(client_message_id),
         :ok <- validate_text(text),
         :ok <- validate_attachment_ids(attachment_ids) do
      validate_content(text, attachment_ids)
    end
  end


  defp validate_client_message_id(client_message_id) do
    if byte_size(client_message_id) in 16..64, do: :ok, else: {:error, :invalid_payload}
  end


  defp validate_text(text) do
    cond do
      byte_size(text) > 16_384 -> {:error, :invalid_payload}
      String.length(text) > 4_000 -> {:error, :invalid_payload}
      true -> :ok
    end
  end


  defp validate_attachment_ids(attachment_ids) do
    cond do
      length(attachment_ids) > 5 -> {:error, :invalid_payload}
      Enum.uniq(attachment_ids) != attachment_ids -> {:error, :invalid_payload}
      not Enum.all?(attachment_ids, &valid_uuid?/1) -> {:error, :invalid_payload}
      true -> :ok
    end
  end


  defp validate_content("", []), do: {:error, :invalid_payload}
  defp validate_content(_text, _attachment_ids), do: :ok


  def request_fingerprint(text, attachment_ids) do
    if attachment_ids == [] do
      :crypto.hash(:sha256, text)
    else
      composite_fingerprint(text, attachment_ids)
    end
  end


  defp composite_fingerprint(text, attachment_ids) do
    :crypto.hash(
      :sha256,
      JSON.encode!(%{"version" => 2, "text" => text, "attachment_ids" => attachment_ids})
    )
  end


  defp valid_uuid?(value) when is_binary(value) do
    case UUID.dump(value) do
      {:ok, _uuid} -> true
      _error -> false
    end
  end

  defp valid_uuid?(_value), do: false
end
