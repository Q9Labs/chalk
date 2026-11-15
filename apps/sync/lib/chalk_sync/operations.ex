defmodule ChalkSync.Operations do
  @moduledoc """
  Node-local operational state and bounded graceful drain coordination.

  Draining first rejects new upgrades and command reservations. Existing
  decision tasks receive their normal bounded transaction window. Coordinators
  then drain queued frames and close sockets with retryable service-restart
  semantics; all durable recovery remains in PostgreSQL.
  """

  use GenServer

  alias ChalkSync.Episodes.CommandIntake
  alias ChalkSync.Episodes.Coordinator

  @default_drain_timeout_ms 3_000
  @poll_interval_ms 25

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @serving_key {__MODULE__, :serving}
  @boot_key {__MODULE__, :boot_check_passed}

  @doc """
  Opens the node to sockets. Production Sync stays closed until the presence witness is written,
  so a socket never lives before the recovery floor protects the leases of a node that was away.
  The flag outlives this process: a restart of it does not close an open node.
  """
  @spec begin_serving() :: :ok
  def begin_serving, do: :persistent_term.put(@serving_key, true)

  @doc """
  Keeps sockets out while the production boot checks have not passed. The boot check calls this
  when the database was away at start, so the checks that need it run later, and calls
  `boot_check_passed/0` once they pass.
  """
  @spec hold_for_boot_check() :: :ok
  def hold_for_boot_check, do: :persistent_term.put(@boot_key, false)

  @spec boot_check_passed() :: :ok
  def boot_check_passed, do: :persistent_term.put(@boot_key, true)

  @spec serving?() :: boolean()
  def serving? do
    :persistent_term.get(@boot_key, true) and
      :persistent_term.get(
        @serving_key,
        not Application.fetch_env!(:chalk_sync, :database_workers)
      )
  end

  @spec accepting_connections?(GenServer.server()) :: boolean()
  def accepting_connections?(server \\ __MODULE__) do
    serving?() and GenServer.call(server, :accepting_connections, 250)
  catch
    :exit, _reason -> false
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__), do: GenServer.call(server, :health, 250)

  @spec begin_drain(non_neg_integer()) :: :ok | {:timeout, non_neg_integer()}
  def begin_drain(timeout_ms \\ @default_drain_timeout_ms)
      when is_integer(timeout_ms) and timeout_ms >= 0 do
    begin_drain(__MODULE__, timeout_ms)
  end

  @spec begin_drain(GenServer.server(), non_neg_integer()) ::
          :ok | {:timeout, non_neg_integer()}
  def begin_drain(server, timeout_ms) when is_integer(timeout_ms) and timeout_ms >= 0 do
    GenServer.call(server, {:begin_drain, timeout_ms}, timeout_ms + 1_000)
  catch
    :exit, _reason -> {:timeout, 0}
  end

  @impl GenServer
  def init(options) do
    {:ok,
     %{
       draining?: false,
       drain_result: nil,
       drain_started_at_ms: nil,
       drain_deadline_ms: nil,
       waiters: [],
       admission: Keyword.get(options, :admission, CommandIntake),
       drain_fun: Keyword.get(options, :drain_fun, &Coordinator.drain_all/0),
       clock: Keyword.get(options, :clock, fn -> System.monotonic_time(:millisecond) end)
     }}
  end

  @impl GenServer
  def handle_call(:accepting_connections, _from, state),
    do: {:reply, not state.draining?, state}

  def handle_call(:health, _from, state) do
    {:reply,
     %{
       draining: state.draining?,
       drain_started_at_ms: state.drain_started_at_ms
     }, state}
  end

  def handle_call({:begin_drain, timeout_ms}, from, %{draining?: false} = state) do
    :ok = CommandIntake.start_draining(state.admission)
    now = state.clock.()
    send(self(), :drain_poll)

    {:noreply,
     %{
       state
       | draining?: true,
         drain_started_at_ms: now,
         drain_deadline_ms: now + timeout_ms,
         waiters: [from]
     }}
  end

  def handle_call({:begin_drain, _timeout_ms}, _from, %{drain_result: result} = state)
      when not is_nil(result) do
    {:reply, result, state}
  end

  def handle_call({:begin_drain, _timeout_ms}, from, state) do
    {:noreply, %{state | waiters: [from | state.waiters]}}
  end

  @impl GenServer
  def handle_info(:drain_poll, state) do
    stats = CommandIntake.stats(state.admission)
    now = state.clock.()

    cond do
      stats.node_commands == 0 ->
        finish_drain(state, :ok)

      now >= state.drain_deadline_ms ->
        finish_drain(state, {:timeout, stats.node_commands})

      true ->
        Process.send_after(self(), :drain_poll, @poll_interval_ms)
        {:noreply, state}
    end
  end

  defp finish_drain(state, result) do
    :ok = state.drain_fun.()
    Enum.each(state.waiters, &GenServer.reply(&1, result))
    {:noreply, %{state | waiters: [], drain_deadline_ms: nil, drain_result: result}}
  end
end
