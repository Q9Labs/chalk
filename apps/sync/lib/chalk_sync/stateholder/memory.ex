defmodule ChalkSync.Stateholder.Memory do
  @moduledoc """
  ETS-backed stateholder adapter for single-node dev and test.

  All writes serialize through this GenServer so compare-and-set commits are
  atomic even if a second (buggy) writer appears. Reads go straight to ETS.
  """

  @behaviour ChalkSync.Stateholder

  use GenServer

  @rooms __MODULE__.Rooms
  @events __MODULE__.Events
  @sessions __MODULE__.Sessions
  @retained_events 500

  alias ChalkSync.ProtocolV2
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl ChalkSync.Stateholder
  def load(room_id) do
    case :ets.lookup(@rooms, room_id) do
      [{^room_id, state}] -> {:ok, state}
      [] -> :not_found
    end
  end

  @impl ChalkSync.Stateholder
  def commit(room_id, expected_revision, event, state) do
    GenServer.call(__MODULE__, {:commit, room_id, expected_revision, event, state})
  end

  @impl ChalkSync.Stateholder
  def events_since(room_id, cursor) do
    case :ets.lookup(@events, room_id) do
      [] when cursor == 0 ->
        {:ok, []}

      [] ->
        {:error, :cursor_unavailable}

      [{^room_id, newest_first}] ->
        oldest_retained = List.last(newest_first).base_revision

        if cursor < oldest_retained do
          {:error, :cursor_unavailable}
        else
          {:ok, newest_first |> Enum.take_while(&(&1.revision > cursor)) |> Enum.reverse()}
        end
    end
  end

  @impl ChalkSync.Stateholder
  def decide_command(%Identity{} = identity, %Command{} = command) do
    GenServer.call(__MODULE__, {:decide_command, identity, command})
  end

  @impl ChalkSync.Stateholder
  def resolve_receipt(%Identity{} = identity, %Command{} = command) do
    GenServer.call(__MODULE__, {:resolve_receipt, identity, command})
  end

  @impl ChalkSync.Stateholder
  def recover(%Identity{} = identity, cursor) do
    GenServer.call(__MODULE__, {:recover, identity, cursor})
  end

  @doc false
  def recover(%SessionKey{} = session, cursor),
    do: GenServer.call(__MODULE__, {:recover_session, session, cursor})

  @impl ChalkSync.Stateholder
  def recover_session(%SessionKey{} = session, cursor), do: recover(session, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%SessionKey{} = session, after_revision, through_revision) do
    GenServer.call(
      __MODULE__,
      {:recovery_page, session, after_revision, through_revision}
    )
  end

  @impl ChalkSync.Stateholder
  def apply_lifecycle_intent(%SessionKey{} = session, lifecycle_intent_id),
    do: GenServer.call(__MODULE__, {:apply_lifecycle_intent, session, lifecycle_intent_id})

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(_session, _lifecycle_intent_id, _reason), do: :ok

  @impl ChalkSync.Stateholder
  def pending_lifecycle_intents(_limit), do: {:ok, []}

  @doc "Seeds one deterministic Session for adapter conformance tests."
  def seed_session(%SessionKey{} = session, participants \\ []) when is_list(participants) do
    GenServer.call(__MODULE__, {:seed_session, session, participants})
  end

  @doc "Test helper: drops all rooms and events."
  def reset do
    GenServer.call(__MODULE__, :reset)
  end

  @impl GenServer
  def init(_opts) do
    :ets.new(@rooms, [:named_table, :protected, read_concurrency: true])
    :ets.new(@events, [:named_table, :protected, read_concurrency: true])
    :ets.new(@sessions, [:named_table, :protected, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:commit, room_id, expected_revision, event, state}, _from, s) do
    current_revision =
      case :ets.lookup(@rooms, room_id) do
        [{^room_id, current}] -> current.revision
        [] -> 0
      end

    if current_revision == expected_revision do
      :ets.insert(@rooms, {room_id, state})
      append_event(room_id, event)
      {:reply, :ok, s}
    else
      {:reply, {:error, {:revision_conflict, current_revision}}, s}
    end
  end

  def handle_call(:reset, _from, s) do
    :ets.delete_all_objects(@rooms)
    :ets.delete_all_objects(@events)
    :ets.delete_all_objects(@sessions)
    {:reply, :ok, s}
  end

  def handle_call({:seed_session, session, participants}, _from, server_state) do
    authority_key = SessionKey.authority_key(session)

    if :ets.member(@sessions, authority_key) do
      {:reply, {:error, :already_exists}, server_state}
    else
      case seeded_session(session, participants) do
        {:ok, state} ->
          :ets.insert(@sessions, {authority_key, state})
          {:reply, :ok, server_state}

        {:error, reason} ->
          {:reply, {:error, reason}, server_state}
      end
    end
  end

  def handle_call({:decide_command, identity, command}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> decide(session, identity, command)
        [] -> {:retryable, :dependency_unavailable}
      end

    case reply do
      {:ok, decision, session} ->
        :ets.insert(@sessions, {authority_key, session})
        {:reply, {:ok, decision}, server_state}

      other ->
        {:reply, other, server_state}
    end
  end

  def handle_call({:resolve_receipt, identity, command}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> receipt_decision(session, identity, command)
        [] -> {:retryable, :dependency_unavailable}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:recover, identity, cursor}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> recover_identity(session, identity, cursor)
        [] -> {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:recover_session, session_key, cursor}, _from, server_state) do
    authority_key = SessionKey.authority_key(session_key)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> {:ok, recovery(session, cursor)}
        [] -> {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:recovery_page, session_key, after_revision, through_revision},
        _from,
        server_state
      ) do
    authority_key = SessionKey.authority_key(session_key)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] ->
          events =
            session.events
            |> :queue.to_list()
            |> Enum.filter(&(&1.revision > after_revision and &1.revision <= through_revision))
            |> bounded_recovery_page()

          {:ok, events}

        [] ->
          {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:apply_lifecycle_intent, session_key, lifecycle_intent_id},
        _from,
        server_state
      ) do
    authority_key = SessionKey.authority_key(session_key)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] ->
          lifecycle_decision(session, lifecycle_intent_id)

        [] ->
          {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  defp lifecycle_decision(session, lifecycle_intent_id) do
    lifecycle_intent_id = normalize_id(lifecycle_intent_id)

    if lifecycle_intent_applied?(session, lifecycle_intent_id) do
      {:ok,
       %LifecycleDecision{
         lifecycle_intent_id: lifecycle_intent_id,
         result: :already_applied
       }}
    else
      {:error, :lifecycle_intent_not_found}
    end
  end

  defp lifecycle_intent_applied?(session, lifecycle_intent_id) do
    Enum.any?(session.participants, fn {_id, participant} ->
      participant.admission_lifecycle_intent_id == lifecycle_intent_id and
        participant.status == :active
    end)
  end

  defp append_event(room_id, event) do
    newest_first =
      case :ets.lookup(@events, room_id) do
        [{^room_id, events}] -> events
        [] -> []
      end

    :ets.insert(@events, {room_id, Enum.take([event | newest_first], @retained_events)})
  end

  defp seeded_session(session_key, participants) do
    initial = %{
      session: session_key,
      state: Reducer.new(session_key.session_id),
      participants: %{},
      receipts: %{},
      events: :queue.new()
    }

    Enum.reduce_while(participants, {:ok, initial}, fn participant, {:ok, session} ->
      with %{id: raw_id, generation: generation, display_name: display_name} <- participant,
           id = normalize_id(raw_id),
           true <- is_binary(id) and is_integer(generation) and generation > 0,
           {:ok, event, state} <-
             Reducer.apply_lifecycle(session.state, :participant_joined, %{
               "participant_session_id" => id,
               "display_name" => display_name
             }) do
        product = %{
          generation: generation,
          status: :active,
          capabilities: Map.get(participant, :capabilities, ["control:hand"]),
          admission_lifecycle_intent_id:
            participant |> Map.get(:admission_lifecycle_intent_id) |> normalize_id()
        }

        next = %{
          session
          | state: state,
            participants: Map.put(session.participants, id, product),
            events: :queue.in(memory_event(event, nil, nil, state), session.events)
        }

        {:cont, {:ok, next}}
      else
        _ -> {:halt, {:error, :invalid_participant}}
      end
    end)
  end

  defp decide(session, identity, command) do
    case receipt_decision(session, identity, command) do
      {:ok, decision} -> {:ok, decision, session}
      :not_found -> decide_new(session, identity, command)
    end
  end

  defp decide_new(session, identity, command) do
    with {:ok, participant} <- active_participant(session, identity),
         :ok <- capability(participant, command.name) do
      persist_reducer_decision(session, identity, command)
    else
      {:error, reason} -> persist_rejection(session, identity, command, reason)
    end
  end

  defp persist_reducer_decision(session, identity, command) do
    case Reducer.decide_command(
           session.state,
           normalize_id(identity.participant_session_id),
           command.name,
           command.payload
         ) do
      {:ok, event, state} -> persist_commit(session, identity, command, event, state)
      {:error, reason} -> persist_rejection(session, identity, command, normalize_reason(reason))
    end
  end

  defp persist_commit(session, identity, command, event, state) do
    event_id = UUID.generate()
    stored_event = memory_event(event, event_id, command.id, state)

    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :committed,
      event_id: event_id,
      revision: event.revision,
      reason: nil
    }

    session = %{
      session
      | state: state,
        events: :queue.in(stored_event, session.events),
        receipts: Map.put(session.receipts, receipt_key(identity, command), receipt)
    }

    decision = %Decision{
      command_id: command.id,
      result: :committed,
      event_id: event_id,
      revision: event.revision,
      event: stored_event
    }

    {:ok, decision, session}
  end

  defp persist_rejection(session, identity, command, reason) do
    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :rejected,
      event_id: nil,
      revision: nil,
      reason: reason
    }

    session = %{
      session
      | receipts: Map.put(session.receipts, receipt_key(identity, command), receipt)
    }

    {:ok, %Decision{command_id: command.id, result: :rejected, reason: reason}, session}
  end

  defp receipt_decision(session, identity, command) do
    key = receipt_key(identity, command)

    case session.receipts do
      %{^key => receipt} ->
        {:ok, decision_from_receipt(command, receipt)}

      _ ->
        :not_found
    end
  end

  defp decision_from_receipt(command, %{fingerprint: fingerprint})
       when fingerprint != command.fingerprint do
    %Decision{
      command_id: command.id,
      result: :command_id_conflict,
      reason: :command_id_conflict
    }
  end

  defp decision_from_receipt(command, %{outcome: :committed} = receipt) do
    %Decision{
      command_id: command.id,
      result: :duplicate,
      event_id: receipt.event_id,
      revision: receipt.revision
    }
  end

  defp decision_from_receipt(command, %{outcome: :rejected} = receipt) do
    %Decision{command_id: command.id, result: :rejected, reason: receipt.reason}
  end

  defp active_participant(session, identity) do
    participant_session_id = normalize_id(identity.participant_session_id)
    submitted_generation = identity.participant_session_generation

    case session.participants do
      %{
        ^participant_session_id =>
          %{status: :active, generation: ^submitted_generation} = participant
      } ->
        validate_memory_admission(participant, identity)

      %{^participant_session_id => %{generation: _generation}} ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp validate_memory_admission(participant, %{admission_lifecycle_intent_id: nil}),
    do: {:ok, participant}

  defp validate_memory_admission(
         %{admission_lifecycle_intent_id: admission_id} = participant,
         %{admission_lifecycle_intent_id: claimed_admission_id}
       )
       when is_binary(admission_id),
       do:
         if(normalize_id(claimed_admission_id) == admission_id,
           do: {:ok, participant},
           else: {:error, :participant_inactive}
         )

  defp validate_memory_admission(_participant, _identity),
    do: {:error, :participant_inactive}

  defp capability(%{capabilities: capabilities}, name) when name in [:raise_hand, :lower_hand] do
    if "control:hand" in capabilities, do: :ok, else: {:error, :capability_denied}
  end

  defp recovery(session, nil), do: snapshot_recovery(session)

  defp recovery(session, %{revision: revision, state_schema_version: schema, digest: digest})
       when is_integer(revision) and revision >= 0 and is_integer(schema) and is_binary(digest) do
    head = recovery_head(session.state)

    recovery_for_cursor(
      session,
      %{revision: revision, state_schema_version: schema, digest: digest},
      head
    )
  end

  defp recovery(session, _cursor), do: snapshot_recovery(session)

  defp recovery_for_cursor(session, cursor, head) do
    cond do
      cursor_matches_head?(cursor, head) ->
        %Recovery{mode: :up_to_date, head: head, snapshot: nil, events: []}

      cursor.revision < head.revision and historical_cursor_matches?(session, cursor) ->
        replay_recovery(session, cursor.revision, head)

      true ->
        snapshot_recovery(session)
    end
  end

  defp cursor_matches_head?(cursor, head) do
    cursor.revision == head.revision and
      cursor.state_schema_version == head.state_schema_version and
      cursor.digest == head.digest
  end

  defp historical_cursor_matches?(session, cursor) do
    cursor.state_schema_version == Reducer.state_schema_version() and
      historical_digest(session, cursor.revision) == cursor.digest
  end

  defp historical_digest(session, 0),
    do: session.session.session_id |> Reducer.new() |> Reducer.digest()

  defp historical_digest(session, revision) do
    session.events
    |> :queue.to_list()
    |> Enum.find_value(fn event ->
      if event.revision == revision, do: event.resulting_state_digest
    end)
  end

  defp replay_recovery(session, revision, head) do
    retained = :queue.to_list(session.events)
    events = Enum.filter(retained, &(&1.revision > revision))
    oldest_revision = if match?([_ | _], retained), do: hd(retained).base_revision, else: 0

    if revision >= oldest_revision and length(events) <= 2_048 and
         Enum.sum(Enum.map(events, &(ProtocolV2.event(&1) |> byte_size()))) <= 2 * 1024 * 1024 do
      %Recovery{
        mode: :replay,
        head: head,
        snapshot: nil,
        events: [],
        replay_cursor: revision
      }
    else
      snapshot_recovery(session)
    end
  end

  defp bounded_recovery_page(events) do
    events
    |> Enum.reduce_while({[], 0}, fn event, {accepted, bytes} ->
      event_bytes = event |> ProtocolV2.event() |> byte_size()

      if length(accepted) < 128 and bytes + event_bytes <= 255 * 1024,
        do: {:cont, {[event | accepted], bytes + event_bytes}},
        else: {:halt, {accepted, bytes}}
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp recover_identity(session, identity, cursor) do
    case active_participant(session, identity) do
      {:ok, _participant} -> {:ok, recovery(session, cursor)}
      {:error, reason} -> {:ok, terminal_recovery(session, reason)}
    end
  end

  defp snapshot_recovery(session) do
    mode = if session.state.status == "ended", do: :terminal, else: :snapshot

    %Recovery{
      mode: mode,
      head: recovery_head(session.state),
      snapshot: if(mode == :terminal, do: nil, else: Reducer.snapshot(session.state)),
      events: [],
      terminal_reason: if(mode == :terminal, do: :session_ended)
    }
  end

  defp terminal_recovery(session, reason) do
    %Recovery{
      mode: :terminal,
      head: recovery_head(session.state),
      snapshot: nil,
      events: [],
      terminal_reason: reason
    }
  end

  defp recovery_head(state) do
    %{
      revision: state.revision,
      state_schema_version: Reducer.state_schema_version(),
      digest: Reducer.digest(state)
    }
  end

  defp memory_event(event, event_id, command_id, state) do
    event
    |> Map.put(:event_id, event_id || UUID.generate())
    |> Map.put(:command_id, command_id)
    |> Map.put(:lifecycle_intent_id, if(command_id, do: nil, else: UUID.generate()))
    |> Map.put(:schema_version, 1)
    |> Map.put(:resulting_state_digest, Reducer.digest(state))
  end

  defp receipt_key(identity, command),
    do: {normalize_id(identity.participant_session_id), command.id}

  defp normalize_reason(:not_joined), do: :participant_inactive
  defp normalize_reason(:no_change), do: :invalid_state
  defp normalize_reason(:session_ended), do: :session_ended
  defp normalize_reason(_reason), do: :invalid_state

  defp normalize_id(nil), do: nil
  defp normalize_id(value) when is_binary(value), do: String.downcase(value)
end
