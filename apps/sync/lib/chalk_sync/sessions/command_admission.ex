defmodule ChalkSync.Sessions.CommandAdmission do
  @moduledoc """
  Node-local admission for bounded durable command work.

  Reservation messages contain only authority keys and byte counts. Decoded
  payloads stay in the calling socket until a supervised task has capacity.
  Every accepted task releases its lease in an `after` path, including crashes
  and caller disconnects.
  """

  use GenServer

  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.Telemetry

  @session_command_limit 32
  @session_byte_limit 512 * 1024
  @session_task_limit 8
  @node_command_limit 512
  @node_byte_limit 16 * 1024 * 1024

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    task_supervisor = Keyword.get(options, :task_supervisor, ChalkSync.CommandTaskSupervisor)
    decision_fun = Keyword.get(options, :decision_fun, &Stateholder.decide_command/2)

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

    case GenServer.call(server, {:reserve, identity.session, bytes}, 1_000) do
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
       sessions: %{},
       leases: %{},
       monitors: %{}
     }}
  end

  @impl GenServer
  def handle_call({:reserve, session, bytes}, _from, state) do
    key = SessionKey.authority_key(session)
    current = Map.get(state.sessions, key, %{commands: 0, bytes: 0, tasks: 0})

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
       sessions: state.sessions
     }, state}
  end

  defp reserve_if_admissible(state, key, current, bytes) do
    if admissible?(state, current, bytes) do
      lease = make_ref()

      session_state = %{
        commands: current.commands + 1,
        bytes: current.bytes + bytes,
        tasks: current.tasks + 1
      }

      next = %{
        state
        | node_commands: state.node_commands + 1,
          node_bytes: state.node_bytes + bytes,
          sessions: Map.put(state.sessions, key, session_state),
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
             send(caller, {:sync_command_result, lease, command.id, result})
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

  defp safe_release(server, lease) do
    GenServer.call(server, {:release, lease})
  catch
    :exit, _reason -> :ok
  end

  defp admissible?(state, session, bytes) do
    bytes > 0 and
      state.node_commands < @node_command_limit and
      state.node_bytes + bytes <= @node_byte_limit and
      session.commands < @session_command_limit and
      session.bytes + bytes <= @session_byte_limit and
      session.tasks < @session_task_limit
  end

  defp release_lease(state, lease) do
    case Map.pop(state.leases, lease) do
      {nil, _leases} ->
        state

      {{key, bytes}, leases} ->
        Telemetry.execute([:command, :release], %{bytes: bytes}, %{outcome: :released})
        {monitor, monitors} = pop_lease_monitor(state.monitors, lease)
        if monitor, do: Process.demonitor(monitor, [:flush])
        session = Map.fetch!(state.sessions, key)

        next_session = %{
          commands: session.commands - 1,
          bytes: session.bytes - bytes,
          tasks: session.tasks - 1
        }

        sessions =
          if next_session.commands == 0,
            do: Map.delete(state.sessions, key),
            else: Map.put(state.sessions, key, next_session)

        %{
          state
          | node_commands: state.node_commands - 1,
            node_bytes: state.node_bytes - bytes,
            sessions: sessions,
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
