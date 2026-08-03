defmodule ChalkSync.Reliability.Wire do
  @moduledoc false

  import ExUnit.Assertions

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.TestWSClient, as: Client

  def connect_v1(port, identity) do
    case connect_v1_result(port, identity) do
      {:ok, client, welcome} ->
        {client, welcome}

      {:closed, code, reason, _client} ->
        flunk("v1 socket closed during recovery: #{code} #{reason}")

      {:error, reason} ->
        flunk("v1 socket failed to connect: #{inspect(reason)}")

      {:error, reason, _client} ->
        flunk("v1 socket recovery failed: #{inspect(reason)}")
    end
  end

  def connect_v1_result(port, identity) do
    with {:ok, client} <- Client.connect(port, "/v1/sync"),
         client <- Client.send_json(client, v1_hello(identity)),
         {:ok, client, welcome} <- receive_json_type_result(client, "welcome", 5_000),
         client <- Client.acknowledge_recovery(client, welcome),
         {:ok, client, _complete} <-
           receive_json_type_result(client, "recovery_complete", 5_000),
         {:ok, client, _media} <-
           receive_json_type_result(client, "projection_snapshot", 5_000),
         {:ok, client, _presence} <-
           receive_json_type_result(client, "projection_snapshot", 5_000) do
      {:ok, client, welcome}
    end
  end

  def commit_hand(client, command_id, raised) do
    case commit_hand_result(client, command_id, raised) do
      {:ok, client, frames} ->
        {client, frames}

      {:closed, code, reason, _client} ->
        flunk("socket closed while committing #{command_id}: #{code} #{reason}")

      {:error, reason, _client} ->
        flunk("socket failed while committing #{command_id}: #{inspect(reason)}")
    end
  end

  def commit_hand_result(client, command_id, raised) do
    client = send_hand(client, command_id, raised)
    receive_command_frames(client, command_id, %{}, 6)
  end

  def send_hand(client, command_id, raised) do
    client =
      Client.send_json(client, %{
        "type" => "command",
        "command_id" => command_id,
        "name" => "set_hand_raised",
        "payload" => %{"raised" => raised}
      })

    client
  end

  def receive_command_ack(client, command_id) do
    receive_command_ack(client, command_id, 8)
  end

  def receive_json_type(client, expected_type, timeout \\ 5_000) do
    case receive_json_type_result(client, expected_type, timeout) do
      {:ok, client, frame} ->
        {client, frame}

      {:closed, code, reason, _client} ->
        flunk("socket closed while waiting for #{expected_type}: #{code} #{reason}")

      {:error, reason, _client} ->
        flunk("socket failed while waiting for #{expected_type}: #{inspect(reason)}")
    end
  end

  def receive_json_type_result(client, expected_type, timeout \\ 5_000) do
    receive_json_type_result(client, expected_type, timeout, 8)
  end

  def token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "display_name" => "Reliability Test",
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end

  def available_port do
    {:ok, socket} = :gen_tcp.listen(0, ip: {127, 0, 0, 1})
    {:ok, {_address, port}} = :inet.sockname(socket)
    :ok = :gen_tcp.close(socket)
    port
  end

  def database_url_with_port(database_url, port) do
    database_url
    |> URI.parse()
    |> Map.put(:host, "127.0.0.1")
    |> Map.put(:port, port)
    |> URI.to_string()
  end

  defp receive_command_frames(client, _command_id, frames, _remaining)
       when is_map_key(frames, "ack") and is_map_key(frames, "event"),
       do: {:ok, client, frames}

  defp receive_command_frames(client, command_id, _frames, 0),
    do: {:error, {:missing_command_frames, command_id}, client}

  defp receive_command_frames(client, command_id, frames, remaining) do
    case Client.recv(client, 5_000) do
      {:json, frame, client} ->
        frames =
          if frame["command_id"] == command_id and frame["type"] in ["ack", "event"],
            do: Map.put(frames, frame["type"], frame),
            else: frames

        receive_command_frames(client, command_id, frames, remaining - 1)

      {:closed, code, reason, client} ->
        {:closed, code, reason, client}

      {:error, :timeout} ->
        {:error, :timeout, client}

      {:error, reason, client} ->
        {:error, reason, client}
    end
  end

  defp receive_command_ack(client, command_id, 0),
    do: {:error, {:missing_ack, command_id}, client}

  defp receive_command_ack(client, command_id, remaining) do
    case Client.recv(client, 5_000) do
      {:json, %{"type" => "ack", "command_id" => ^command_id} = ack, client} ->
        {:ok, client, ack}

      {:json, _frame, client} ->
        receive_command_ack(client, command_id, remaining - 1)

      {:closed, code, reason, client} ->
        {:closed, code, reason, client}

      {:error, :timeout} ->
        {:error, :timeout, client}

      {:error, reason, client} ->
        {:error, reason, client}
    end
  end

  defp receive_json_type_result(client, expected_type, _timeout, 0),
    do: {:error, {:missing_frame, expected_type}, client}

  defp receive_json_type_result(client, expected_type, timeout, remaining) do
    case Client.recv(client, timeout) do
      {:json, %{"type" => ^expected_type} = frame, client} ->
        {:ok, client, frame}

      {:json, _frame, client} ->
        receive_json_type_result(client, expected_type, timeout, remaining - 1)

      {:closed, code, reason, client} ->
        {:closed, code, reason, client}

      {:error, :timeout} ->
        {:error, :timeout, client}

      {:error, reason, client} ->
        {:error, reason, client}
    end
  end

  defp v1_hello(identity) do
    %{
      "type" => "hello",
      "protocol" => 1,
      "token" => token(identity),
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end
end
