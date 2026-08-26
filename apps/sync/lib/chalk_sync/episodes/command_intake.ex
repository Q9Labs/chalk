defmodule ChalkSync.Episodes.CommandIntake do
  @moduledoc """
  Node-local admission for bounded durable command work.

  Reservation messages contain only authority keys and byte counts. Decoded
  payloads stay in the calling socket until a supervised task has capacity.
  Every accepted task releases its lease in an `after` path, including crashes
  and caller disconnects.
  """

  use GenServer

  alias ChalkSync.DeliveryGate
  alias ChalkSync.Live.MediaPlaneCall
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.ObservedContext
  alias ChalkSync.Telemetry

  @episode_command_limit 32
  @episode_byte_limit 512 * 1024
  @episode_task_limit 8
  @node_command_limit 512
  @node_byte_limit 16 * 1024 * 1024

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    task_supervisor = Keyword.get(options, :task_supervisor, ChalkSync.CommandTaskSupervisor)
    decision_fun = Keyword.get(options, :decision_fun, &decide_command/2)

    GenServer.start_link(
      __MODULE__,
      %{task_supervisor: task_supervisor, decision_fun: decision_fun},
      name: name
    )
  end

  @spec submit(GenServer.server(), Identity.t(), Command.t(), pid()) ::
          {:ok, reference()} | {:error, :overloaded | :server_draining}
  def submit(server \\ __MODULE__, %Identity{} = identity, %Command{} = command, caller \\ self()) do
    bytes = command.normalized_bytes + byte_size(command.id)

    case GenServer.call(server, {:reserve, identity.episode, bytes}, 1_000) do
      {:ok, lease} -> start_task(server, lease, identity, command, caller)
      {:error, reason} when reason in [:overloaded, :server_draining] -> {:error, reason}
    end
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  @spec stats(GenServer.server()) :: map()
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @spec start_draining(GenServer.server()) :: :ok
  def start_draining(server \\ __MODULE__), do: GenServer.call(server, :start_draining)

  @impl GenServer
  def init(options) do
    {:ok,
     %{
       task_supervisor: options.task_supervisor,
       decision_fun: options.decision_fun,
       draining?: false,
       node_commands: 0,
       node_bytes: 0,
       episodes: %{},
       leases: %{},
       monitors: %{}
     }}
  end

  @impl GenServer
  def handle_call({:reserve, episode, bytes}, _from, state) do
    key = EpisodeKey.authority_key(episode)
    current = Map.get(state.episodes, key, %{commands: 0, bytes: 0, tasks: 0})

    if state.draining? do
      Telemetry.execute([:command, :admission], %{bytes: bytes}, %{outcome: :server_draining})
      {:reply, {:error, :server_draining}, state}
    else
      reserve_if_admissible(state, key, current, bytes)
    end
  end

  def handle_call(:start_draining, _from, state),
    do: {:reply, :ok, %{state | draining?: true}}

  def handle_call({:release, lease}, _from, state) do
    {:reply, :ok, release_lease(state, lease)}
  end

  def handle_call({:track, lease, pid}, _from, state) do
    if Map.has_key?(state.leases, lease) do
      monitor = Process.monitor(pid)
      {:reply, :ok, %{state | monitors: Map.put(state.monitors, monitor, lease)}}
    else
      {:reply, :gone, state}
    end
  end

  def handle_call(:task_config, _from, state),
    do: {:reply, {state.task_supervisor, state.decision_fun}, state}

  def handle_call(:stats, _from, state) do
    {:reply,
     %{
       draining?: state.draining?,
       node_commands: state.node_commands,
       node_bytes: state.node_bytes,
       episodes: state.episodes
     }, state}
  end

  defp reserve_if_admissible(state, key, current, bytes) do
    if admissible?(state, current, bytes) do
      lease = make_ref()

      episode_state = %{
        commands: current.commands + 1,
        bytes: current.bytes + bytes,
        tasks: current.tasks + 1
      }

      next = %{
        state
        | node_commands: state.node_commands + 1,
          node_bytes: state.node_bytes + bytes,
          episodes: Map.put(state.episodes, key, episode_state),
          leases: Map.put(state.leases, lease, {key, bytes})
      }

      Telemetry.execute([:command, :admission], %{bytes: bytes}, %{outcome: :accepted})
      {:reply, {:ok, lease}, next}
    else
      Telemetry.execute([:command, :admission], %{bytes: bytes}, %{outcome: :overloaded})
      {:reply, {:error, :overloaded}, state}
    end
  end

  @impl GenServer
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Map.pop(state.monitors, monitor) do
      {nil, _monitors} ->
        {:noreply, state}

      {lease, monitors} ->
        {:noreply, state |> Map.put(:monitors, monitors) |> release_lease(lease)}
    end
  end

  defp start_task(server, lease, identity, command, caller) do
    {task_supervisor, decision_fun} = GenServer.call(server, :task_config)

    case Task.Supervisor.start_child(task_supervisor, fn ->
           try do
             result = decide_safely(decision_fun, identity, command)
             emit_episode_event(command, result)

             DeliveryGate.emit(
               :command_result,
               %{outcome: command_result_outcome(result)},
               caller,
               {:sync_command_result, lease, command.id, result}
             )
           after
             safe_release(server, lease)
           end
         end) do
      {:ok, pid} ->
        GenServer.call(server, {:track, lease, pid})
        {:ok, lease}

      {:error, _reason} ->
        GenServer.call(server, {:release, lease})
        {:error, :overloaded}
    end
  catch
    :exit, _reason ->
      safe_release(server, lease)
      {:error, :overloaded}
  end

  defp decide_safely(decision_fun, identity, command) do
    decision_fun.(identity, command)
  rescue
    _exception -> {:retryable, :decision_unavailable}
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  defp command_result_outcome({:ok, %{result: outcome}}), do: outcome
  defp command_result_outcome({:error, reason}), do: reason
  defp command_result_outcome({:retryable, reason}), do: reason
  defp command_result_outcome(_result), do: :unknown

  defp emit_episode_event(
         %Command{observed_context: %ObservedContext{} = observed},
         {:ok, %{delivery: :original, event: event}}
       )
       when is_map(event) do
    # Stateholder has returned only after the durable receipt/event commit. Emit
    # before the volatile result delivery so a dropped frame cannot hide it.
    context =
      Observability.persisted_context(
        observed.journey_id,
        observed.producing_trace_id,
        observed.producing_span_id,
        observed.producing_traceparent,
        observed.producing_tracestate
      )

    Observability.episode_event(context, event)

    :ok
  end

  defp emit_episode_event(_command, _result), do: :ok

  defp decide_command(
         %Identity{protocol_version: 1} = identity,
         %Command{name: name} = command
       )
       when name in [:assign_roles] do
    case Application.get_env(:chalk_sync, :media_plane) do
      {module, adapter} ->
        observe_role_transition(module, adapter, identity, command)

      nil ->
        {:retryable, :dependency_unavailable}
    end
  end

  defp decide_command(%Identity{} = identity, %Command{} = command),
    do: Stateholder.decide_command(identity, command)

  defp observe_role_transition(module, adapter, identity, command) do
    MediaPlaneCall.invoke(fn ->
      module.observe_episode_publications(adapter, identity.episode, nil)
    end)
    |> role_transition_observation(identity, command)
  end

  defp role_transition_observation({:ok, %{publications: publications}}, identity, command),
    do: Stateholder.begin_role_transition(identity, command, publications)

  defp role_transition_observation({:error, _reason}, _identity, _command),
    do: {:retryable, :dependency_unavailable}

  defp role_transition_observation(_invalid, _identity, _command),
    do: {:retryable, :dependency_unavailable}

  defp safe_release(server, lease) do
    GenServer.call(server, {:release, lease})
  catch
    :exit, _reason -> :ok
  end

  defp admissible?(state, episode, bytes) do
    bytes > 0 and
      state.node_commands < @node_command_limit and
      state.node_bytes + bytes <= @node_byte_limit and
      episode.commands < @episode_command_limit and
      episode.bytes + bytes <= @episode_byte_limit and
      episode.tasks < @episode_task_limit
  end

  defp release_lease(state, lease) do
    case Map.pop(state.leases, lease) do
      {nil, _leases} ->
        state

      {{key, bytes}, leases} ->
        Telemetry.execute([:command, :release], %{bytes: bytes}, %{outcome: :released})
        {monitor, monitors} = pop_lease_monitor(state.monitors, lease)
        if monitor, do: Process.demonitor(monitor, [:flush])
        episode = Map.fetch!(state.episodes, key)

        next_episode = %{
          commands: episode.commands - 1,
          bytes: episode.bytes - bytes,
          tasks: episode.tasks - 1
        }

        episodes =
          if next_episode.commands == 0,
            do: Map.delete(state.episodes, key),
            else: Map.put(state.episodes, key, next_episode)

        %{
          state
          | node_commands: state.node_commands - 1,
            node_bytes: state.node_bytes - bytes,
            episodes: episodes,
            leases: leases,
            monitors: monitors
        }
    end
  end

  defp pop_lease_monitor(monitors, lease) do
    case Enum.find(monitors, fn {_monitor, monitored_lease} -> monitored_lease == lease end) do
      nil -> {nil, monitors}
      {monitor, ^lease} -> {monitor, Map.delete(monitors, monitor)}
    end
  end
end
