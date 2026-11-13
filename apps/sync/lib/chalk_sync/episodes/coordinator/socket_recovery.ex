defmodule ChalkSync.Episodes.Coordinator.SocketRecovery do
  @moduledoc """
  A socket's recovery as the Coordinator drives it: the welcome, the paged replay frames and their acknowledgements. Every function takes the Coordinator state.
  """

  alias ChalkSync.Episodes.Coordinator.Subscribers
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Transport.OutboundQueue

  def activate_socket_recovery(state, socket, subscriber, recovery) do
    if Subscribers.compatible_head?(state.head, recovery.head) do
      recovery_id = ProtocolV1.recovery_id()

      encoded =
        ProtocolV1.recovery_welcome(
          subscriber.identity,
          recovery,
          recovery_id,
          subscriber.protocol_options
        )

      recovery_state = %{
        mode: recovery.mode,
        head: recovery.head,
        id: recovery_id,
        cursor: recovery.replay_cursor,
        queued_kind:
          if recovery.mode == :terminal do
            :terminal_welcome
          else
            :welcome
          end,
        expected_ack: nil
      }

      optional_ack =
        if recovery.mode == :up_to_date do
          {recovery_id, recovery.head.revision, Subscribers.digest_hex(recovery.head.digest)}
        end

      next_subscriber = %{
        subscriber
        | recovery: recovery_state,
          optional_recovery_ack: optional_ack
      }

      acknowledgement =
        if recovery.mode == :snapshot do
          %{
            recovery_id: recovery_id,
            revision: recovery.head.revision,
            state_digest: Subscribers.digest_hex(recovery.head.digest),
            queued_kind: :welcome,
            transport_in_flight?: false
          }
        end

      case reserve_recovery_frame(socket, next_subscriber, encoded, false, acknowledgement) do
        {:ok, reserved} ->
          next = %{
            state
            | head: Subscribers.older_head(state.head, recovery.head),
              target_revision: max(state.target_revision, recovery.head.revision),
              sockets: Map.put(state.sockets, socket, reserved)
          }

          {:reply, :ok, next}

        {:error, reason} ->
          {:reply, {:error, reason}, Subscribers.remove_socket(state, socket)}
      end
    else
      {:reply, {:error, :state_digest_mismatch}, Subscribers.remove_socket(state, socket)}
    end
  rescue
    ArgumentError ->
      {:reply, {:error, :invalid_recovery}, Subscribers.remove_socket(state, socket)}
  end

  def enqueue_next_recovery_frame(
        socket,
        %{recovery: %{mode: :replay} = recovery} = subscriber
      )
      when recovery.cursor < recovery.head.revision do
    case Stateholder.recovery_page(
           subscriber.identity.episode,
           recovery.cursor,
           recovery.head.revision
         ) do
      {:ok, [_ | _] = events} ->
        case ProtocolV1.recovery_page(events, recovery.id) do
          {:ok, encoded, last_revision} ->
            next = %{
              subscriber
              | recovery: %{recovery | cursor: last_revision, queued_kind: :page}
            }

            last = List.last(events)

            acknowledgement = %{
              recovery_id: recovery.id,
              revision: last_revision,
              state_digest:
                last |> Subscribers.field(:resulting_state_digest) |> Subscribers.digest_hex(),
              queued_kind: :page,
              transport_in_flight?: false
            }

            reserve_recovery_frame(socket, next, encoded, true, acknowledgement)

          {:error, reason} ->
            {:error, reason}
        end

      {:ok, []} ->
        {:error, :revision_gap}

      {:error, reason} ->
        {:error, reason}

      {:retryable, _reason} ->
        {:error, :dependency_unavailable}
    end
  end

  def enqueue_next_recovery_frame(socket, subscriber) do
    recovery = subscriber.recovery

    encoded =
      ProtocolV1.recovery_complete(
        %Recovery{mode: recovery.mode, head: recovery.head, snapshot: nil, events: []},
        recovery.id
      )

    next = %{subscriber | recovery: %{recovery | queued_kind: :complete}}
    reserve_recovery_frame(socket, next, encoded, false, nil)
  end

  defp reserve_recovery_frame(socket, subscriber, encoded, replay_page?, acknowledgement) do
    options =
      [replay_page?: replay_page?]
      |> Keyword.put(:revision, acknowledgement && acknowledgement.revision)
      |> Keyword.put(:state_digest, acknowledgement && acknowledgement.state_digest)

    case OutboundQueue.push(subscriber.queue, encoded, options) do
      :ok ->
        send(socket, {:sync_outbound_ready, self()})

        recovery = %{subscriber.recovery | expected_ack: acknowledgement}
        {:ok, %{subscriber | recovery: recovery, notified?: true}}

      {:error, {:overflow, reason}} ->
        {:error, reason}

      {:error, reason} ->
        {:error, reason}
    end
  end

  def acknowledge_recovery_frame(
        state,
        socket,
        %{recovery: %{expected_ack: expected}} = subscriber,
        recovery_id,
        revision,
        state_digest
      )
      when is_map(expected) do
    exact? =
      expected.transport_in_flight? and expected.recovery_id == recovery_id and
        expected.revision == revision and expected.state_digest == state_digest and
        expected.queued_kind == subscriber.recovery.queued_kind

    if exact? do
      release_recovery_frame(state, socket, subscriber, revision, state_digest)
    else
      fail_recovery_ack(state, socket, subscriber, :invalid_recovery_ack)
    end
  end

  def acknowledge_recovery_frame(
        state,
        socket,
        subscriber,
        _recovery_id,
        _revision,
        _state_digest
      ) do
    fail_recovery_ack(state, socket, subscriber, :invalid_recovery_ack)
  end

  defp release_recovery_frame(state, socket, subscriber, revision, state_digest) do
    case OutboundQueue.ack_recovery(subscriber.queue, revision, state_digest) do
      {:ok, _stats} ->
        recovery = %{subscriber.recovery | expected_ack: nil}
        acknowledged = %{subscriber | recovery: recovery}

        case enqueue_next_recovery_frame(socket, acknowledged) do
          {:ok, next_subscriber} ->
            {:reply, :ok, %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}

          {:error, reason} ->
            fail_recovery_ack(state, socket, subscriber, reason)
        end

      {:error, reason} ->
        fail_recovery_ack(state, socket, subscriber, reason)
    end
  end

  defp fail_recovery_ack(state, socket, subscriber, reason) do
    Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
    {:reply, {:error, reason}, Subscribers.remove_socket(state, socket)}
  end
end
