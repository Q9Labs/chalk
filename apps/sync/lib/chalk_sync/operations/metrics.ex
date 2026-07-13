defmodule ChalkSync.Operations.Metrics do
  @moduledoc """
  Bounded in-node aggregate metrics for the production sync runtime.

  Telemetry handlers update a fixed-shape ETS counter table directly, so metric
  traffic cannot create one process message per command or event.
  """

  use GenServer

  alias ChalkSync.Sessions.CommandAdmission

  @events [
    [:chalk, :sync, :command, :admission],
    [:chalk, :sync, :command, :release],
    [:chalk, :sync, :command, :decision],
    [:chalk, :sync, :recovery, :read],
    [:chalk, :sync, :fanout, :notification],
    [:chalk, :sync, :queue, :overflow],
    [:chalk, :sync, :lifecycle, :decision],
    [:chalk, :sync, :lifecycle, :poll],
    [:chalk, :sync, :external_operation, :finalization],
    [:chalk, :sync, :external_operation, :poll],
    [:chalk, :sync, :webhook, :production],
    [:chalk, :sync, :webhook, :fanout],
    [:chalk, :sync, :retention, :cleanup]
  ]

  @outcomes ~w(
    accepted overloaded server_draining released committed duplicate rejected retryable error
    snapshot replay up_to_date terminal valid malformed event_limit byte_limit age_limit
    replay_page_limit applied already_applied superseded success failure operation_failure queued
  )
  @handler_id __MODULE__

  def start_link(options \\ []) do
    name = Keyword.get(options, :name, __MODULE__)
    GenServer.start_link(__MODULE__, options, name: name)
  end

  @spec snapshot(GenServer.server()) :: map()
  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot, 500)

  @doc false
  def handle_event(event, measurements, metadata, table) do
    outcome = metadata |> Map.get(:outcome, :other) |> normalize_outcome()
    key = {event, outcome, metric_labels(event, metadata)}
    count = bounded_count(Map.get(measurements, :count, 1))
    duration_us = bounded_integer(measurements[:duration_us])
    bytes = bounded_integer(measurements[:bytes])

    :ets.update_counter(
      table,
      key,
      [{2, count}, {3, duration_us}, {4, bytes}],
      {key, 0, 0, 0}
    )

    :ok
  catch
    :error, :badarg -> :ok
  end

  @impl GenServer
  def init(_options) do
    table = :ets.new(__MODULE__, [:set, :public, write_concurrency: true])
    :telemetry.detach(@handler_id)

    :ok = :telemetry.attach_many(@handler_id, @events, &__MODULE__.handle_event/4, table)
    {:ok, %{table: table}}
  end

  @impl GenServer
  def handle_call(:snapshot, _from, state) do
    metrics =
      state.table
      |> :ets.tab2list()
      |> Enum.sort()
      |> Map.new(fn {{event, outcome, labels}, count, duration_us, bytes} ->
        {metric_name(event, outcome, labels),
         %{count: count, total_duration_us: duration_us, total_bytes: bytes}}
      end)

    {:reply, %{metrics: metrics, resources: resources()}, state}
  end

  @impl GenServer
  def terminate(_reason, _state) do
    :telemetry.detach(@handler_id)
    :ok
  end

  defp resources do
    admission = CommandAdmission.stats()
    supervisor = DynamicSupervisor.count_children(ChalkSync.Sessions.Supervisor)

    %{
      admitted_command_bytes: admission.node_bytes,
      admitted_commands: admission.node_commands,
      command_admission_draining: admission.draining?,
      local_session_coordinators: supervisor.active
    }
  catch
    :exit, _reason -> %{"status" => "unavailable"}
  end

  defp normalize_outcome(outcome) when is_atom(outcome),
    do: outcome |> Atom.to_string() |> normalize_outcome()

  defp normalize_outcome(outcome) when outcome in @outcomes, do: outcome
  defp normalize_outcome(_outcome), do: "other"

  defp metric_labels(
         event,
         %{event_name: event_name, api_version: api_version}
       )
       when event in [
              [:chalk, :sync, :webhook, :production],
              [:chalk, :sync, :webhook, :fanout]
            ] and event_name in ["participant.joined", "participant.left", "session.ended"] and
              api_version == 1,
       do: [String.replace(event_name, ".", "_"), "v1"]

  defp metric_labels(_event, _metadata), do: []

  defp metric_name(event, outcome, labels),
    do: Enum.join(Enum.map(event, &Atom.to_string/1) ++ [outcome | labels], ".")

  defp bounded_count(value) when is_integer(value) and value >= 0, do: value
  defp bounded_count(_value), do: 1

  defp bounded_integer(value) when is_integer(value) and value >= 0, do: value
  defp bounded_integer(_value), do: 0
end
