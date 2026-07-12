defmodule ChalkSync.Operations do
  @moduledoc """
  Node-local operational state and bounded graceful drain coordination.

  Draining first rejects new upgrades and command reservations. Existing
  decision tasks receive their normal bounded transaction window. Coordinators
  then drain queued frames and close sockets with retryable service-restart
  semantics; all durable recovery remains in PostgreSQL.
  """

  use GenServer

  alias ChalkSync.Sessions.CommandAdmission
  alias ChalkSync.Sessions.Coordinator

  @default_drain_timeout_ms 3_000
  @poll_interval_ms 25

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec accepting_connections?(GenServer.server()) :: boolean()
  def accepting_connections?(server \\ __MODULE__) do
    GenServer.call(server, :accepting_connections, 250)
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
       admission: Keyword.get(options, :admission, CommandAdmission),
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
    :ok = CommandAdmission.start_draining(state.admission)
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
    stats = CommandAdmission.stats(state.admission)
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
