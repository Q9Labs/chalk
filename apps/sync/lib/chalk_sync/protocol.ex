defmodule ChalkSync.Protocol do
  @moduledoc """
  Sync wire protocol v1 — JSON text frames, language-neutral by construction.

  The generated v1 contract owns frame metadata and validation. This adapter
  only converts JSON text to validated frames and encodes room-server output.

  Client -> server:

      {"type":"hello","protocol":1,"token":"...","streams":{"control":{"cursor":41}}}
      {"type":"command","command_id":"c-1","name":"raise_hand","payload":{}}
      {"type":"ping"}

  Server -> client:

      {"type":"welcome","protocol":1,"participant_id":"p1",
       "mode":"snapshot","snapshot":{...}}                      # or
       "mode":"replay","events":[...],"control_revision":41}
      {"type":"event","stream":"control","name":"hand_raised",
       "base_revision":41,"revision":42,"payload":{...}}
      {"type":"ack","command_id":"c-1","result":"committed","revision":42}
      {"type":"ack","command_id":"c-1","result":"duplicate","revision":42}
      {"type":"ack","command_id":"c-1","result":"rejected","reason":"no_change"}
      {"type":"error","code":"unauthorized","message":"..."}
      {"type":"pong"}
  """

  alias ChalkSync.Contract.Generated

  def version, do: Generated.protocol_version()

  # -- Decoding ----------------------------------------------------------------

  @type frame :: Generated.client_frame()

  @spec decode(binary()) :: {:ok, frame()} | {:error, atom()}
  def decode(text) do
    case JSON.decode(text) do
      {:ok, %{} = frame} -> Generated.decode_client_frame(frame)
      {:ok, _} -> {:error, :missing_type}
      {:error, _} -> {:error, :malformed_json}
    end
  end

  # -- Encoding ----------------------------------------------------------------

  def encode_welcome(participant_id, %{snapshot: %{} = snapshot}) do
    JSON.encode!(%{
      "type" => "welcome",
      "protocol" => Generated.protocol_version(),
      "participant_id" => participant_id,
      "mode" => "snapshot",
      "snapshot" => snapshot
    })
  end

  def encode_welcome(participant_id, %{replay: events, control_revision: revision}) do
    JSON.encode!(%{
      "type" => "welcome",
      "protocol" => Generated.protocol_version(),
      "participant_id" => participant_id,
      "mode" => "replay",
      "events" => Enum.map(events, &event_body/1),
      "control_revision" => revision
    })
  end

  def encode_event(event) do
    JSON.encode!(Map.put(event_body(event), "type", "event"))
  end

  def encode_ack(command_id, {:committed, revision}),
    do: ack(command_id, "committed", "revision", revision)

  def encode_ack(command_id, {:duplicate, revision}),
    do: ack(command_id, "duplicate", "revision", revision)

  def encode_ack(command_id, {:rejected, reason}),
    do: ack(command_id, "rejected", "reason", to_string(reason))

  def encode_error(code, message) do
    JSON.encode!(%{"type" => "error", "code" => to_string(code), "message" => message})
  end

  def encode_pong, do: JSON.encode!(%{"type" => "pong"})

  defp ack(command_id, result, key, value) do
    JSON.encode!(%{"type" => "ack", "command_id" => command_id, "result" => result, key => value})
  end

  defp event_body(event) do
    %{
      "stream" => "control",
      "name" => event.name,
      "base_revision" => event.base_revision,
      "revision" => event.revision,
      "payload" => event.payload
    }
  end
end
