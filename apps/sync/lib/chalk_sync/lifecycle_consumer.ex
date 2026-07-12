defmodule ChalkSync.LifecycleConsumer do
  @moduledoc """
  Bounded, idempotent delivery loop for API-created lifecycle intents.

  Discovery holds no row locks. Each returned ID is applied by the Stateholder
  through the same Session control lock used by commands. Concurrent nodes may
  discover the same ID; the durable intent status makes the result idempotent.
  """

  use GenServer

  require Logger

  alias ChalkSync.Sessions.Coordinator
  alias ChalkSync.Stateholder
  alias ChalkSync.Telemetry

  @default_poll_interval_ms 100
  @default_page_size 32

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec health(GenServer.server()) :: map()
  def health(server \\ __MODULE__), do: GenServer.call(server, :health)

  @impl GenServer
  def init(options) do
    state = %{
      page_size: Keyword.get(options, :page_size, @default_page_size),
      poll_interval_ms: Keyword.get(options, :poll_interval_ms, @default_poll_interval_ms),
      last_success_at_ms: nil,
      consecutive_failures: 0,
      applied_count: 0
    }

    send(self(), :poll)
    {:ok, state}
  end

  @impl GenServer
  def handle_call(:health, _from, state), do: {:reply, state, state}

  @impl GenServer
  def handle_info(:poll, state) do
    {delay, state} = poll(state)
    Process.send_after(self(), :poll, delay)
    {:noreply, state}
  end

  defp poll(state) do
    case Stateholder.pending_lifecycle_intents(state.page_size) do
      {:ok, intents} ->
        {applied, failures, recording_failures} = apply_page(intents)

        Telemetry.execute(
          [:lifecycle, :poll],
          %{bytes: 0},
          %{outcome: poll_outcome(failures, recording_failures)}
        )

        next = %{
          state
          | last_success_at_ms: System.monotonic_time(:millisecond),
            consecutive_failures:
              if(recording_failures == 0, do: 0, else: state.consecutive_failures + 1),
            applied_count: state.applied_count + applied
        }

        delay = poll_delay(length(intents), failures, state.page_size, state.poll_interval_ms)
        {delay, next}

      {:retryable, reason} ->
        Telemetry.execute([:lifecycle, :poll], %{}, %{outcome: :failure})
        Logger.warning("sync lifecycle discovery unavailable: #{reason}")
        {state.poll_interval_ms, %{state | consecutive_failures: state.consecutive_failures + 1}}
    end
  end

  defp apply_page(intents) do
    Enum.reduce(intents, {0, 0, 0}, fn {session, intent_id},
                                       {applied, failures, recording_failures} ->
      case Stateholder.apply_lifecycle_intent(session, intent_id) do
        {:ok, %{result: result} = decision}
        when result in [:applied, :already_applied, :superseded] ->
          publish_lifecycle_event(session, decision)
          {applied + 1, failures, recording_failures}

        {:retryable, reason} ->
          Logger.warning(
            "sync lifecycle intent retryable: session_id=#{session.session_id} intent_id=#{intent_id} reason=#{reason}"
          )

          record_lifecycle_failure(
            session,
            intent_id,
            reason,
            applied,
            failures,
            recording_failures
          )

        {:error, reason} ->
          Logger.error(
            "sync lifecycle intent invalid: session_id=#{session.session_id} intent_id=#{intent_id} reason=#{reason}"
          )

          record_lifecycle_failure(
            session,
            intent_id,
            reason,
            applied,
            failures,
            recording_failures
          )
      end
    end)
  end

  defp record_lifecycle_failure(session, intent_id, reason, applied, failures, recording_failures) do
    case Stateholder.record_lifecycle_failure(session, intent_id, reason) do
      :ok ->
        {applied, failures + 1, recording_failures}

      {:retryable, recording_reason} ->
        Logger.warning(
          "sync lifecycle failure record unavailable: session_id=#{session.session_id} intent_id=#{intent_id} reason=#{recording_reason}"
        )

        {applied, failures + 1, recording_failures + 1}
    end
  end

  defp poll_outcome(0, 0), do: :success
  defp poll_outcome(_failures, 0), do: :intent_failure
  defp poll_outcome(_failures, _recording_failures), do: :failure

  defp publish_lifecycle_event(session, %{event: event}) when is_map(event),
    do: Coordinator.publish(session, event)

  defp publish_lifecycle_event(_session, _decision), do: :ok

  @doc false
  @spec poll_delay(non_neg_integer(), non_neg_integer(), pos_integer(), pos_integer()) ::
          non_neg_integer()
  def poll_delay(intent_count, 0, page_size, _poll_interval_ms)
      when intent_count == page_size,
      do: 0

  def poll_delay(_intent_count, _failure_count, _page_size, poll_interval_ms),
    do: poll_interval_ms
end
