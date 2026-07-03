defmodule ChalkSync.Protocol do
  @moduledoc """
  Sync wire protocol v1 — JSON text frames, language-neutral by construction.

  This module is the only place the wire shape lives; transports and room
  logic never touch raw JSON. The schema source of truth for SDK generation
  will formalize these shapes (see north star: one schema generates every SDK
  and the server contract).

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

  @protocol_version 1

  # Clients may only issue these; join/leave are socket-lifecycle driven.
  @client_commands %{"raise_hand" => :raise_hand, "lower_hand" => :lower_hand}

  def version, do: @protocol_version

  # -- Decoding ----------------------------------------------------------------

  @type frame ::
          {:hello, %{token: String.t(), cursor: non_neg_integer() | nil}}
          | {:command, %{command_id: String.t(), name: atom(), payload: map()}}
          | :ping

  @spec decode(binary()) :: {:ok, frame()} | {:error, atom()}
  def decode(text) do
    case JSON.decode(text) do
      {:ok, %{"type" => type} = frame} -> decode_frame(type, frame)
      {:ok, _} -> {:error, :missing_type}
      {:error, _} -> {:error, :malformed_json}
    end
  end

  defp decode_frame("hello", %{"protocol" => @protocol_version, "token" => token} = frame)
       when is_binary(token) do
    case get_in(frame, ["streams", "control", "cursor"]) do
      cursor when is_integer(cursor) and cursor >= 0 ->
        {:ok, {:hello, %{token: token, cursor: cursor}}}

      nil ->
        {:ok, {:hello, %{token: token, cursor: nil}}}

      _ ->
        {:error, :invalid_cursor}
    end
  end

  defp decode_frame("hello", %{"protocol" => version}) when version != @protocol_version,
    do: {:error, :unsupported_protocol}

  defp decode_frame("hello", _frame), do: {:error, :invalid_hello}

  defp decode_frame("command", %{"command_id" => command_id, "name" => name} = frame)
       when is_binary(command_id) and is_binary(name) do
    case @client_commands do
      %{^name => command} ->
        payload = Map.get(frame, "payload", %{})

        if is_map(payload) do
          {:ok, {:command, %{command_id: command_id, name: command, payload: payload}}}
        else
          {:error, :invalid_payload}
        end

      _ ->
        {:error, :unknown_command}
    end
  end

  defp decode_frame("command", _frame), do: {:error, :invalid_command}
  defp decode_frame("ping", _frame), do: {:ok, :ping}
  defp decode_frame(_type, _frame), do: {:error, :unknown_type}

  # -- Encoding ----------------------------------------------------------------

  def encode_welcome(participant_id, %{snapshot: %{} = snapshot}) do
    JSON.encode!(%{
      "type" => "welcome",
      "protocol" => @protocol_version,
      "participant_id" => participant_id,
      "mode" => "snapshot",
      "snapshot" => snapshot
    })
  end

  def encode_welcome(participant_id, %{replay: events, control_revision: revision}) do
    JSON.encode!(%{
      "type" => "welcome",
      "protocol" => @protocol_version,
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
