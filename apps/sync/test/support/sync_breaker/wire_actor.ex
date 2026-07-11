defmodule ChalkSync.SyncBreaker.WireActor do
  @moduledoc false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.SyncBreaker.Model
  alias ChalkSync.TestWSClient

  @enforce_keys [:tenant_id, :room_id, :participant_id, :display_name]
  defstruct [
    :tenant_id,
    :room_id,
    :participant_id,
    :display_name,
    :client,
    model: nil,
    connected: false,
    frames: [],
    acknowledgements: %{}
  ]

  def new(tenant_id, room_id, participant_id, display_name) do
    %__MODULE__{
      tenant_id: tenant_id,
      room_id: room_id,
      participant_id: participant_id,
      display_name: display_name
    }
  end

  def connect(%__MODULE__{} = actor, port, cursor \\ nil) do
    with {:ok, client} <- TestWSClient.connect(port),
         client <- TestWSClient.send_json(client, hello(actor, cursor)),
         {:ok, welcome, client, observed} <- receive_type(client, "welcome", 2_000),
         {:ok, model} <- apply_welcome(actor.model, welcome) do
      {:ok,
       %{
         actor
         | client: client,
           connected: true,
           model: model,
           frames: actor.frames ++ observed
       }, welcome}
    end
  end

  def send_command(%__MODULE__{connected: true} = actor, command_id, name, payload \\ %{}) do
    client =
      TestWSClient.send_json(actor.client, %{
        "type" => "command",
        "command_id" => command_id,
        "name" => Atom.to_string(name),
        "payload" => payload
      })

    %{actor | client: client}
  end

  def await_ack(%__MODULE__{connected: true} = actor, command_id, timeout \\ 2_000) do
    predicate = fn frame -> frame["type"] == "ack" and frame["command_id"] == command_id end

    with {:ok, ack, client, observed} <- receive_matching(actor.client, predicate, timeout),
         {:ok, actor} <- apply_observed(%{actor | client: client}, observed) do
      acknowledgements = Map.put(actor.acknowledgements, command_id, ack)
      {:ok, %{actor | acknowledgements: acknowledgements}, ack}
    end
  end

  def drain(%__MODULE__{connected: true} = actor) do
    case TestWSClient.drain(actor.client) do
      {:ok, frames, client} ->
        apply_raw_frames(%{actor | client: client}, frames)

      {:closed, frames, client} ->
        apply_raw_frames(%{actor | client: client, connected: false}, frames)

      {:error, reason, frames, client} ->
        {:error, {:transport, reason}, %{actor | client: client}, frames}
    end
  end

  def await_revision(%__MODULE__{connected: true} = actor, revision, timeout \\ 2_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    await_revision_until(actor, revision, deadline, [])
  end

  def close(%__MODULE__{connected: true} = actor) do
    %{actor | client: TestWSClient.close(actor.client), connected: false}
  end

  def close_tcp(%__MODULE__{connected: true} = actor) do
    %{actor | client: TestWSClient.close_tcp(actor.client), connected: false}
  end

  def revision(%__MODULE__{model: %Model{revision: revision}}), do: revision
  def revision(%__MODULE__{model: nil}), do: nil

  defp await_revision_until(
         %__MODULE__{model: %Model{revision: current_revision}} = actor,
         revision,
         _deadline,
         observed
       )
       when current_revision >= revision do
    {:ok, actor, observed}
  end

  defp await_revision_until(actor, revision, deadline, observed) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    case TestWSClient.recv_frame(actor.client, timeout) do
      {:frame, frame, client} ->
        case apply_raw_frames(%{actor | client: client}, [frame]) do
          {:ok, actor, frames} ->
            await_revision_until(actor, revision, deadline, observed ++ frames)

          {:error, reason, _actor, frames} ->
            {:error, reason, observed ++ frames}
        end

      {:closed, code, reason, _client} ->
        {:error, {:closed, code, reason}, observed}

      {:error, :timeout, _client} ->
        {:error, {:timeout, revision, revision(actor)}, observed}

      {:error, reason, _client} ->
        {:error, {:transport, reason}, observed}
    end
  end

  defp hello(actor, cursor) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => actor.tenant_id,
        "room_id" => actor.room_id,
        "participant_id" => actor.participant_id,
        "display_name" => actor.display_name
      })

    frame = %{"type" => "hello", "protocol" => 1, "token" => token}

    if is_integer(cursor) do
      Map.put(frame, "streams", %{"control" => %{"cursor" => cursor}})
    else
      frame
    end
  end

  defp receive_type(client, type, timeout) do
    receive_matching(client, &(&1["type"] == type), timeout)
  end

  defp receive_matching(client, predicate, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    receive_matching_until(client, predicate, deadline, [])
  end

  defp receive_matching_until(client, predicate, deadline, observed) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    case TestWSClient.recv_frame(client, timeout) do
      {:frame, {:text, text}, client} ->
        decode_matching_text(text, client, predicate, deadline, observed)

      {:frame, frame, _client} ->
        {:error, {:unexpected_frame, frame}}

      {:closed, code, reason, _client} ->
        {:error, {:closed, code, reason}}

      {:error, :timeout, _client} ->
        {:error, {:timeout, observed}}

      {:error, reason, _client} ->
        {:error, {:transport, reason}}
    end
  end

  defp decode_matching_text(text, client, predicate, deadline, observed) do
    case JSON.decode(text) do
      {:ok, frame} ->
        continue_matching(frame, client, predicate, deadline, observed ++ [frame])

      {:error, _reason} ->
        {:error, {:invalid_json, text}}
    end
  end

  defp continue_matching(frame, client, predicate, deadline, observed) do
    if predicate.(frame),
      do: {:ok, frame, client, observed},
      else: receive_matching_until(client, predicate, deadline, observed)
  end

  defp apply_raw_frames(actor, frames) do
    frames
    |> Enum.reduce_while({:ok, actor, []}, fn
      {:text, text}, {:ok, actor, observed} ->
        apply_raw_text(actor, observed, text)

      frame, {:ok, actor, observed} ->
        {:halt, {:error, {:unexpected_frame, frame}, actor, observed}}
    end)
    |> case do
      {:ok, actor, observed} -> {:ok, %{actor | frames: actor.frames ++ observed}, observed}
      error -> error
    end
  end

  defp apply_raw_text(actor, observed, text) do
    case JSON.decode(text) do
      {:ok, frame} -> apply_decoded_frame(actor, observed, frame)
      {:error, _reason} -> {:halt, {:error, {:invalid_json, text}, actor, observed}}
    end
  end

  defp apply_decoded_frame(actor, observed, frame) do
    case apply_frame(actor, frame) do
      {:ok, actor} -> {:cont, {:ok, actor, observed ++ [frame]}}
      {:error, reason} -> {:halt, {:error, reason, actor, observed ++ [frame]}}
    end
  end

  defp apply_observed(actor, observed) do
    Enum.reduce_while(observed, {:ok, actor}, fn frame, {:ok, actor} ->
      case apply_frame(actor, frame) do
        {:ok, actor} -> {:cont, {:ok, actor}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, actor} -> {:ok, %{actor | frames: actor.frames ++ observed}}
      error -> error
    end
  end

  defp apply_frame(actor, %{"type" => "event"} = event) do
    case Model.apply_event(actor.model, event) do
      {:ok, model} -> {:ok, %{actor | model: model}}
      {:error, reason} -> {:error, {:replica, reason, event}}
    end
  end

  defp apply_frame(actor, %{"type" => "welcome"} = welcome) do
    case apply_welcome(actor.model, welcome) do
      {:ok, model} -> {:ok, %{actor | model: model}}
      {:error, reason} -> {:error, reason}
    end
  end

  defp apply_frame(actor, %{"type" => "ack"} = ack) do
    {:ok, put_in(actor.acknowledgements[ack["command_id"]], ack)}
  end

  defp apply_frame(actor, %{"type" => type}) when type in ["error", "pong"], do: {:ok, actor}
  defp apply_frame(_actor, frame), do: {:error, {:unknown_server_frame, frame}}

  defp apply_welcome(_model, %{"mode" => "snapshot", "snapshot" => snapshot}) do
    Model.from_snapshot(snapshot)
  end

  defp apply_welcome(%Model{} = model, %{
         "mode" => "replay",
         "events" => events,
         "control_revision" => control_revision
       }) do
    case Model.replay(model, events) do
      {:ok, %Model{revision: ^control_revision} = model} -> {:ok, model}
      {:ok, model} -> {:error, {:replay_revision_mismatch, model.revision, control_revision}}
      {:error, reason} -> {:error, {:replay, reason}}
    end
  end

  defp apply_welcome(nil, %{"mode" => "replay"}), do: {:error, :replay_without_replica}
  defp apply_welcome(_model, welcome), do: {:error, {:invalid_welcome, welcome}}
end
