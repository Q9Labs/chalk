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

  @doc "Decodes a frame while preserving optional correlation fields as atom-keyed payload fields; ping becomes `{:ping, correlation_fields}`."
  @spec decode_with_context(binary()) ::
          {:ok, frame(), ChalkSync.Observability.context() | nil} | {:error, atom()}
  def decode_with_context(text) do
    case JSON.decode(text) do
      {:ok, %{} = raw_frame} ->
        case Generated.decode_client_frame(raw_frame) do
          {:ok, frame} -> {:ok, frame, ChalkSync.Observability.context(raw_frame)}
          {:error, _reason} = error -> error
        end

      {:ok, _other} ->
        {:error, :missing_type}

      {:error, _reason} ->
        {:error, :malformed_json}
    end
  end

  # -- Encoding ----------------------------------------------------------------

  def encode_welcome(participant_id, reply, context \\ nil)

  def encode_welcome(participant_id, %{snapshot: %{} = snapshot}, context) do
    encode(
      %{
        "type" => "welcome",
        "protocol" => Generated.protocol_version(),
        "participant_id" => participant_id,
        "mode" => "snapshot",
        "snapshot" => snapshot
      },
      context
    )
  end

  def encode_welcome(participant_id, %{replay: events, control_revision: revision}, context) do
    encode(
      %{
        "type" => "welcome",
        "protocol" => Generated.protocol_version(),
        "participant_id" => participant_id,
        "mode" => "replay",
        "events" => Enum.map(events, &event_body/1),
        "control_revision" => revision
      },
      context
    )
  end

  def encode_event(event, context \\ nil) do
    event
    |> event_body()
    |> Map.put("type", "event")
    |> encode(context)
  end

  def encode_ack(command_id, result, context \\ nil)

  def encode_ack(command_id, {:committed, revision}, context),
    do: ack(command_id, "committed", "revision", revision, context)

  def encode_ack(command_id, {:duplicate, revision}, context),
    do: ack(command_id, "duplicate", "revision", revision, context)

  def encode_ack(command_id, {:rejected, reason}, context),
    do: ack(command_id, "rejected", "reason", to_string(reason), context)

  def encode_error(code, message, context \\ nil) do
    encode(%{"type" => "error", "code" => to_string(code), "message" => message}, context)
  end

  def encode_pong(context \\ nil), do: encode(%{"type" => "pong"}, context)

  defp ack(command_id, result, key, value, context) do
    encode(
      %{"type" => "ack", "command_id" => command_id, "result" => result, key => value},
      context
    )
  end

  defp encode(frame, context) do
    frame
    |> Map.merge(ChalkSync.Observability.frame_fields(context))
    |> JSON.encode!()
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
