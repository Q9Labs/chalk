defmodule ChalkSync.SyncBreakerV3.ScriptedMediaPlane do
  @moduledoc false

  use GenServer

  @behaviour ChalkSync.MediaPlane
  @behaviour ChalkSync.RecordingPlane

  @max_actions 128
  @max_calls 256
  @max_effects 128

  def start_controller(actions \\ [], options \\ []) when is_list(actions) do
    if length(actions) <= @max_actions do
      GenServer.start_link(
        __MODULE__,
        {actions, Keyword.get(options, :controller, self()), Keyword.get(options, :truth)}
      )
    else
      {:error, :action_limit}
    end
  end

  def adapter(controller), do: %{controller: controller}
  def restart_adapter(%{controller: controller}), do: %{controller: controller}

  def restart_controller(controller) do
    truth =
      controller
      |> GenServer.call(:durable_truth)
      |> Map.update!(:incarnation, &(&1 + 1))

    start_controller([], truth: truth)
  end

  def calls(controller), do: GenServer.call(controller, :calls)
  def effects(controller), do: GenServer.call(controller, :effects)
  def projection(controller), do: GenServer.call(controller, :projection)

  def publish_observation(controller, version),
    do: GenServer.call(controller, {:publish_observation, version})

  def confirmed_publication_loss(controller, session, participant_id, source) do
    GenServer.call(
      controller,
      {:effect, :revoke_publication, "publication-loss:#{participant_id}:#{source}",
       [session, participant_id, source]}
    )
  end

  def bounds, do: %{"actions" => @max_actions, "calls" => @max_calls, "effects" => @max_effects}
  def release(controller, tag), do: GenServer.call(controller, {:release, tag})

  @impl true
  def grant_publication(adapter, operation_id, session, participant_id, source),
    do: execute(adapter, :grant_publication, operation_id, [session, participant_id, source])

  @impl true
  def revoke_publication(adapter, operation_id, session, participant_id, source),
    do: execute(adapter, :revoke_publication, operation_id, [session, participant_id, source])

  @impl true
  def remove_participant(adapter, operation_id, session, participant_id),
    do: execute(adapter, :remove_participant, operation_id, [session, participant_id])

  @impl true
  def end_session(adapter, operation_id, session),
    do: execute(adapter, :end_session, operation_id, [session])

  @impl true
  def observe_session_publications(adapter, session),
    do: execute(adapter, :observe_session_publications, nil, [session])

  @impl true
  def start_recording(adapter, operation_id, session, recording_id),
    do: execute(adapter, :start_recording, operation_id, [session, recording_id])

  @impl true
  def stop_recording(adapter, operation_id, session, recording_id),
    do: execute(adapter, :stop_recording, operation_id, [session, recording_id])

  @impl true
  def init({actions, observer, truth}) do
    {:ok,
     Map.merge(
       %{
         actions: actions,
         observer: observer,
         calls: [],
         effects: %{},
         publications: %{},
         recordings: %{},
         held: %{},
         published_version: 0,
         published_publications: [],
         incarnation: 1,
         observation_version: 0,
         snapshots: %{0 => []}
       },
       truth || %{}
     )}
  end

  @impl true
  def handle_call(:calls, _from, state), do: {:reply, Enum.reverse(state.calls), state}

  def handle_call(:durable_truth, _from, state) do
    {:reply,
     Map.take(state, [
       :effects,
       :publications,
       :recordings,
       :incarnation,
       :observation_version,
       :snapshots,
       :published_version,
       :published_publications
     ]), state}
  end

  def handle_call(:effects, _from, state) do
    effects = state.effects |> Map.values() |> Enum.sort_by(& &1.index)
    {:reply, effects, state}
  end

  def handle_call(:projection, _from, state) do
    {:reply,
     %{
       "publications" => Enum.map(publication_list(state), &normalize_publication/1),
       "recordings" => state.recordings |> Map.values() |> Enum.sort(),
       "incarnation" => state.incarnation,
       "observation_version" => state.observation_version
     }, state}
  end

  def handle_call({:release, tag}, _from, state) do
    case Map.pop(state.held, tag) do
      {nil, _held} ->
        {:reply, {:error, :unknown_barrier}, state}

      {pid, held} ->
        send(pid, {:scripted_media_release, tag})
        {:reply, :ok, %{state | held: held}}
    end
  end

  def handle_call({:prepare, operation, operation_id, _arguments}, _from, state) do
    if length(state.calls) >= @max_calls, do: raise("scripted media call limit")
    {action, actions} = take_action(state.actions, operation)
    call = %{operation: operation, operation_id: operation_id, action: action}
    index = length(state.calls) + 1
    send(state.observer, {:scripted_media_observed, index, call})
    {:reply, action, %{state | actions: actions, calls: [call | state.calls]}}
  end

  def handle_call({:effect, operation, operation_id, arguments}, _from, state) do
    key = {operation, operation_id}

    if Map.has_key?(state.effects, key) do
      {:reply, :deduplicated, state}
    else
      if map_size(state.effects) >= @max_effects, do: raise("scripted media effect limit")

      effect = %{
        index: map_size(state.effects) + 1,
        operation: operation,
        operation_id: operation_id
      }

      state =
        apply_effect(
          %{state | effects: Map.put(state.effects, key, effect)},
          operation,
          arguments
        )

      {:reply, :applied, snapshot(state)}
    end
  end

  def handle_call({:observe, version}, _from, state) do
    publications = Map.fetch!(state.snapshots, version)

    {:reply,
     {:ok, %{incarnation: state.incarnation, sequence: version, publications: publications}},
     state}
  end

  def handle_call({:publish_observation, version}, _from, state) do
    if version < state.published_version do
      {:reply, :stale, state}
    else
      publications = Map.fetch!(state.snapshots, version)
      next = %{state | published_version: version, published_publications: publications}
      {:reply, {:published, publications}, next}
    end
  end

  def handle_call(:current_version, _from, state),
    do: {:reply, state.observation_version, state}

  @impl true
  def handle_info({:barrier_reached, pid, tag, point}, state) do
    send(state.observer, {:scripted_media_barrier, tag, point})
    {:noreply, %{state | held: Map.put(state.held, tag, pid)}}
  end

  defp execute(%{controller: controller}, operation, operation_id, arguments) do
    action = GenServer.call(controller, {:prepare, operation, operation_id, arguments})
    execute_action(action, controller, operation, operation_id, arguments)
  end

  defp execute_action({:hold_before_effect, tag}, controller, operation, operation_id, arguments) do
    barrier(controller, tag, :before_effect)
    effect_and_reply(controller, operation, operation_id, arguments, :confirmed)
  end

  defp execute_action({:hold_after_effect, tag}, controller, operation, operation_id, arguments) do
    effect(controller, operation, operation_id, arguments)
    barrier(controller, tag, :after_effect)
    :confirmed
  end

  defp execute_action(:terminal_failure, _controller, _operation, _operation_id, _arguments),
    do: {:terminal_failure, :provider_rejected}

  defp execute_action({:terminal_failure, reason}, _controller, _operation, _id, _arguments),
    do: {:terminal_failure, reason}

  defp execute_action(:ambiguous_before_effect, _controller, _operation, _id, _arguments),
    do: :ambiguous

  defp execute_action(
         :effect_applied_then_response_lost,
         controller,
         operation,
         operation_id,
         arguments
       ) do
    effect(controller, operation, operation_id, arguments)
    :ambiguous
  end

  defp execute_action(:publication_loss, controller, operation, operation_id, arguments) do
    effect(controller, operation, operation_id, arguments)

    GenServer.call(
      controller,
      {:effect, :revoke_publication, "loss:" <> to_string(operation_id), arguments}
    )

    :confirmed
  end

  defp execute_action({:stale_observation, version}, controller, _operation, _id, _arguments),
    do: GenServer.call(controller, {:observe, version})

  defp execute_action(:observe, controller, _operation, _id, _arguments),
    do: GenServer.call(controller, {:observe, current_version(controller)})

  defp execute_action(:confirmed, controller, operation, operation_id, arguments),
    do: effect_and_reply(controller, operation, operation_id, arguments, :confirmed)

  defp execute_action(:satisfied, controller, operation, operation_id, arguments),
    do: effect_and_reply(controller, operation, operation_id, arguments, :satisfied)

  defp barrier(controller, tag, point) do
    send(controller, {:barrier_reached, self(), tag, point})

    receive do
      {:scripted_media_release, ^tag} -> :ok
    end
  end

  defp effect_and_reply(controller, :observe_session_publications, _id, _arguments, _reply),
    do: GenServer.call(controller, {:observe, current_version(controller)})

  defp effect_and_reply(controller, operation, operation_id, arguments, reply) do
    effect(controller, operation, operation_id, arguments)
    reply
  end

  defp effect(_controller, :observe_session_publications, _id, _arguments), do: :ok

  defp effect(controller, operation, operation_id, arguments),
    do: GenServer.call(controller, {:effect, operation, operation_id, arguments})

  defp current_version(controller), do: GenServer.call(controller, :current_version)

  defp take_action([{operation, action} | rest], operation), do: {action, rest}
  defp take_action(actions, :observe_session_publications), do: {:observe, actions}
  defp take_action(actions, _operation), do: {:confirmed, actions}

  defp apply_effect(state, :grant_publication, [_session, participant_id, source]) do
    publication = %{
      participant_session_id: participant_id,
      source: source,
      enabled: true,
      publication_id: "provider-#{participant_id}-#{source}"
    }

    %{state | publications: Map.put(state.publications, {participant_id, source}, publication)}
  end

  defp apply_effect(state, :revoke_publication, [_session, participant_id, source]),
    do: %{state | publications: Map.delete(state.publications, {participant_id, source})}

  defp apply_effect(state, :remove_participant, [_session, participant_id]) do
    publications =
      Map.reject(state.publications, fn {{owner, _source}, _item} -> owner == participant_id end)

    %{state | publications: publications}
  end

  defp apply_effect(state, :end_session, [_session]), do: %{state | publications: %{}}

  defp apply_effect(state, :start_recording, [_session, recording_id]),
    do: %{state | recordings: Map.put(state.recordings, recording_id, recording_id)}

  defp apply_effect(state, :stop_recording, [_session, recording_id]),
    do: %{state | recordings: Map.delete(state.recordings, recording_id)}

  defp apply_effect(state, _operation, _arguments), do: state

  defp snapshot(state) do
    version = state.observation_version + 1
    publications = publication_list(state)

    %{
      state
      | observation_version: version,
        snapshots: Map.put(state.snapshots, version, publications)
    }
  end

  defp publication_list(state),
    do:
      state.publications |> Map.values() |> Enum.sort_by(&{&1.participant_session_id, &1.source})

  defp normalize_publication(publication) do
    %{
      "participant_session_id" => publication.participant_session_id,
      "source" => Atom.to_string(publication.source),
      "enabled" => publication.enabled,
      "publication_id" => publication.publication_id
    }
  end
end
