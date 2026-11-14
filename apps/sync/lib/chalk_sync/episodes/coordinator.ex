defmodule ChalkSync.Episodes.Coordinator do
  @moduledoc """
  Disposable node-local delivery coordinator for one durable Episode.

  PostgreSQL remains authoritative. The coordinator owns only bounded socket queues, coalesced
  head repair, and exact-next local delivery. Losing this process forces normal recovery and
  cannot lose a durable event or decision.
  """

  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Recovery

  def start_link(%EpisodeKey{} = episode) do
    GenServer.start_link(ChalkSync.Episodes.Coordinator.Server, episode, name: via(episode))
  end

  def child_spec(%EpisodeKey{} = episode) do
    %{
      id: {__MODULE__, EpisodeKey.authority_key(episode)},
      start: {__MODULE__, :start_link, [episode]},
      restart: :temporary
    }
  end

  @spec subscribe(Identity.t(), map(), pid()) :: {:ok, pid()} | {:error, atom()}
  def subscribe(%Identity{} = identity, head, socket \\ self()) when is_pid(socket) do
    with {:ok, coordinator} <- ensure_started(identity.episode) do
      GenServer.call(coordinator, {:subscribe, socket, head}, 3000)
    end
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec begin_recovery(Identity.t(), pid(), map()) :: {:ok, pid()} | {:error, atom()}
  def begin_recovery(
        %Identity{} = identity,
        socket \\ self(),
        protocol_options \\ %{}
      )
      when is_pid(socket) and is_map(protocol_options) do
    begin_socket_recovery(identity, socket, protocol_options, true)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  defp begin_socket_recovery(identity, socket, protocol_options, replace?) do
    with {:ok, coordinator} <- ensure_started(identity.episode) do
      monitor = Process.monitor(coordinator)

      try do
        with :ok <-
               GenServer.call(
                 coordinator,
                 {:begin_recovery, socket, identity, protocol_options},
                 3000
               ) do
          {:ok, coordinator}
        end
      catch
        :exit, {reason, {GenServer, :call, _args}}
        when reason in [:normal, :noproc] and replace? ->
          with :ok <- await_coordinator_departure(coordinator, monitor, identity.episode) do
            begin_socket_recovery(identity, socket, protocol_options, false)
          end

        :exit, _reason ->
          {:error, :coordinator_unavailable}
      after
        Process.demonitor(monitor, [:flush])
      end
    end
  end

  defp await_coordinator_departure(coordinator, monitor, episode) do
    receive do
      {:DOWN, ^monitor, :process, ^coordinator, _reason} ->
        case whereis(episode) do
          ^coordinator -> {:error, :coordinator_unavailable}
          _replacement_or_empty -> :ok
        end
    after
      3000 -> {:error, :coordinator_unavailable}
    end
  end

  @spec activate_recovery(pid(), Recovery.t(), pid()) :: :ok | {:error, atom()}
  def activate_recovery(
        coordinator,
        %Recovery{} = recovery,
        socket \\ self(),
        timeout_ms \\ 3000
      ) do
    GenServer.call(coordinator, {:activate_recovery, socket, recovery}, timeout_ms)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec advance_recovery(pid(), pid()) :: :ok | {:error, atom()}
  def advance_recovery(coordinator, socket \\ self()) do
    GenServer.call(coordinator, {:advance_recovery, socket}, 3000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec unsubscribe(pid(), pid()) :: :ok
  def unsubscribe(coordinator, socket \\ self()) do
    GenServer.cast(coordinator, {:unsubscribe, socket})
  end

  @spec publish(EpisodeKey.t(), map()) :: :ok | {:error, atom()}
  def publish(%EpisodeKey{} = episode, event) when is_map(event) do
    case whereis(episode) do
      nil -> :ok
      coordinator -> GenServer.call(coordinator, {:publish, event}, 3000)
    end
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec publish_pending(EpisodeKey.t(), map(), pid()) :: {:ok, [binary()]} | {:error, atom()}
  def publish_pending(%EpisodeKey{} = episode, event, socket \\ self()) when is_map(event) do
    case whereis(episode) do
      nil -> {:ok, []}
      coordinator -> GenServer.call(coordinator, {:publish_pending, socket, event}, 3000)
    end
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec hint(EpisodeKey.t(), non_neg_integer()) :: :ok
  def hint(%EpisodeKey{} = episode, revision) when is_integer(revision) and revision >= 0 do
    case whereis(episode) do
      nil -> :ok
      coordinator -> GenServer.cast(coordinator, {:hint, revision})
    end
  end

  @spec pop(pid(), pid()) ::
          {:ok, binary(),
           false | :recovery_complete | :terminal_welcome | {:terminal, pos_integer(), String.t()}}
          | :empty
          | {:error, atom()}
  def pop(coordinator, socket \\ self()) do
    GenServer.call(coordinator, {:pop, socket}, 1000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec acknowledge(pid(), pos_integer(), String.t(), pid()) :: :ok | {:error, atom()}
  def acknowledge(coordinator, revision, state_digest, socket \\ self())
      when is_integer(revision) and revision >= 1 and is_binary(state_digest) do
    GenServer.call(
      coordinator,
      {:acknowledge, socket, revision, state_digest},
      1000
    )
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec acknowledge_recovery(pid(), String.t(), non_neg_integer(), String.t(), pid()) ::
          :ok | {:error, atom()}
  def acknowledge_recovery(
        coordinator,
        recovery_id,
        revision,
        state_digest,
        socket \\ self()
      )
      when is_binary(recovery_id) and is_integer(revision) and revision >= 0 and
             is_binary(state_digest) do
    GenServer.call(
      coordinator,
      {:acknowledge_recovery, socket, recovery_id, revision, state_digest},
      1000
    )
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec live_target(pid(), Identity.t(), map(), pid()) :: {:ok, map()} | {:error, atom()}
  def live_target(coordinator, %Identity{} = identity, target, socket \\ self()) do
    GenServer.call(
      coordinator,
      {:live_target, socket, identity, target},
      ProviderCall.deadline_ms()
    )
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec directed_request(pid(), Identity.t(), map(), pid()) :: {:ok, map()} | {:error, atom()}
  def directed_request(coordinator, %Identity{} = identity, request, socket \\ self()) do
    GenServer.call(coordinator, {:directed_request, socket, identity, request}, 3000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec acknowledge_request(pid(), Identity.t(), String.t(), pid()) :: :ok | {:error, atom()}
  def acknowledge_request(coordinator, %Identity{} = identity, request_id, socket \\ self()) do
    GenServer.call(coordinator, {:acknowledge_request, socket, identity, request_id}, 1000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec set_connection_quality(pid(), Identity.t(), String.t(), pid()) :: :ok | {:error, atom()}
  def set_connection_quality(coordinator, %Identity{} = identity, quality, socket \\ self()) do
    GenServer.call(coordinator, {:set_connection_quality, socket, identity, quality}, 3000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @doc false
  @spec expire_live_requests(pid(), integer()) :: :ok | {:error, atom()}
  def expire_live_requests(coordinator, now_ms) when is_integer(now_ms) do
    GenServer.call(coordinator, {:expire_live_requests, now_ms}, 1000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @doc false
  @spec reconcile_live(pid()) :: :ok | {:error, atom()}
  def reconcile_live(coordinator) do
    GenServer.call(coordinator, :reconcile_live, ProviderCall.deadline_ms())
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec publication_observed(EpisodeKey.t()) :: :ok
  def publication_observed(%EpisodeKey{} = episode) do
    case whereis(episode) do
      nil -> :ok
      coordinator -> GenServer.cast(coordinator, {:publication_observed, episode.space_id})
    end
  end

  @spec whereis(EpisodeKey.t()) :: pid() | nil
  def whereis(%EpisodeKey{} = episode) do
    case Registry.lookup(ChalkSync.Episodes.Registry, EpisodeKey.authority_key(episode)) do
      [{pid, _value}] -> pid
      [] -> nil
    end
  end

  @spec drain_all() :: :ok
  def drain_all do
    ChalkSync.Episodes.Supervisor
    |> DynamicSupervisor.which_children()
    |> Enum.each(fn {_id, pid, _type, _modules} -> GenServer.cast(pid, :drain) end)

    :ok
  catch
    :exit, _reason -> :ok
  end

  defp ensure_started(episode) do
    case whereis(episode) do
      nil ->
        case DynamicSupervisor.start_child(ChalkSync.Episodes.Supervisor, {__MODULE__, episode}) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, reason} -> {:error, reason}
        end

      pid ->
        {:ok, pid}
    end
  end

  defp via(episode) do
    {:via, Registry, {ChalkSync.Episodes.Registry, EpisodeKey.authority_key(episode)}}
  end
end
