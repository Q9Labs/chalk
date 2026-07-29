defmodule ChalkSync.WhiteboardV1.Protocol do
  @moduledoc "Strict whiteboard-v1 framing for the independent WebSocket transport."

  alias ChalkSync.Contract.GeneratedWhiteboardV1

  @limits GeneratedWhiteboardV1.limits()
  @inbound_frame_bytes @limits["decodedInboundFrameBytes"]
  @outbound_frame_bytes @limits["encodedOutboundFrameBytes"]

  @spec decode(binary()) :: {:ok, term()} | {:error, atom()}
  def decode(text) when is_binary(text) and byte_size(text) <= @inbound_frame_bytes do
    with {:ok, %{} = frame} <- JSON.decode(text),
         {:ok, decoded} <- GeneratedWhiteboardV1.decode_client_frame(frame) do
      {:ok, decoded}
    else
      {:ok, _other} -> {:error, :invalid_frame}
      {:error, %JSON.DecodeError{}} -> {:error, :invalid_json}
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :invalid_frame}
    end
  end

  def decode(text) when is_binary(text), do: {:error, :frame_too_large}
  def decode(_frame), do: {:error, :invalid_frame}

  @spec encode!(map()) :: binary()
  def encode!(frame) do
    encoded = JSON.encode!(frame)

    if GeneratedWhiteboardV1.valid_server_frame?(frame) and
         byte_size(encoded) <= @outbound_frame_bytes do
      encoded
    else
      raise ArgumentError, "invalid whiteboard-v1 server frame"
    end
  end

  def pong, do: encode!(%{"type" => "pong"})

  def operation_error(correlation_id, operation, code, recoverable, message) do
    encode!(%{
      "type" => "operation_error",
      "correlation_id" => correlation_id,
      "operation" => Atom.to_string(operation),
      "code" => Atom.to_string(code),
      "recoverable" => recoverable,
      "message" => message
    })
  end
end
