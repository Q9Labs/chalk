defmodule ChalkSync.Obs do
  @moduledoc """
  The observability kernel: five calls (`op/4`, `transition/6`, `decision/4`, `surface/2`, `fact/2`) that each
  emit one registry-checked record as `:telemetry` event `[:chalk_sync, :obs, :record]`, with the record as metadata.

  The registry in `observability/registry` declares every event, field, reason code and state machine; the
  generated `ChalkSync.Obs.Registry` holds its tables. In closed mode (the test config, or
  CHALK_OBS_MODE=closed) a violation raises `ChalkSync.Obs.Violation`; in open mode (production) it is counted and
  the record still goes out. `ChalkSync.Obs.Check` holds the checks and `ChalkSync.Obs.Flags` the flags hash.
  Configure with

      config :chalk_sync, ChalkSync.Obs, mode: :auto, env: "production", release_sha: "...", source_id: "..."

  A test may also set `clock`, a function that returns Unix milliseconds, to pin `est_server_ms`, and `event_id` and
  `seq`, functions that return the next record's id and sequence number, so a recorded row is the same on every run.
  `ChalkSync.Obs.LogSink` is the production subscriber: it writes each record as one log row.

  See observability/registry/README.md for how a slice declares and emits its events.
  """

  alias ChalkSync.Obs.{Check, Flags, Registry, Violation}

  @event [:chalk_sync, :obs, :record]
  @op_stack {__MODULE__, :op_stack}
  @counters {__MODULE__, :counters}
  @flags_hash {__MODULE__, :flags_hash}
  @source_id {__MODULE__, :source_id}
  @seq 1
  @violations 2
  @export_failures 3

  @on_load :init_counters
  @doc false
  def init_counters do
    :persistent_term.put(@counters, :atomics.new(3, signed: false))
    :persistent_term.put(@source_id, uuid())
    :ok
  end

  @typedoc "Field values keyed by registry field name, as atoms or strings."
  @type fields :: %{optional(atom() | String.t()) => term()} | keyword()
  @type outcome :: :ok | {:expected, String.t()} | {:error, String.t()}

  @doc """
  Runs `fun` and records exactly one terminal outcome. `classify` maps the result to `:ok`, `{:expected, code}` or
  `{:error, code}`; by default `:error` and `{:error, _}` are `error(unclassified)` and anything else is ok. A raise,
  throw or exit is recorded as `error(unclassified)` and then continues. Returns the result of `fun`.
  """
  @spec op(String.t(), fields(), (-> result), classify: (result -> outcome())) :: result
        when result: term()
  def op(name, fields, fun, options \\ []) do
    classify = Keyword.get(options, :classify, &default_classify/1)
    op_id = uuid()
    stack = Process.get(@op_stack, [])
    Process.put(@op_stack, [{op_id, %{}} | stack])
    started = System.monotonic_time(:millisecond)

    {outcome, result} =
      try do
        result = fun.()
        {classify.(result), {:ok, result}}
      catch
        kind, reason -> {{:error, "unclassified"}, {:raise, kind, reason, __STACKTRACE__}}
      end

    [{^op_id, late} | _rest] = Process.get(@op_stack)
    Process.put(@op_stack, stack)
    finish_op(name, Map.merge(normalize(fields), late), outcome, op_id, parent_id(stack), started)

    case result do
      {:ok, value} -> value
      {:raise, kind, reason, stacktrace} -> :erlang.raise(kind, reason, stacktrace)
    end
  end

  @doc "Adds event fields to the innermost running op, for facts learned while it ran."
  @spec set(fields()) :: :ok
  def set(fields) do
    case Process.get(@op_stack, []) do
      [{op_id, late} | rest] ->
        Process.put(@op_stack, [{op_id, Map.merge(late, normalize(fields))} | rest])

      [] ->
        violate(["set/1 called outside an op"])
    end

    :ok
  end

  @doc "The id of the innermost running op in this process, linked as parent_op_id by ops started inside it."
  @spec current_op_id() :: String.t() | nil
  def current_op_id, do: parent_id(Process.get(@op_stack, []))

  defp default_classify(:error), do: {:error, "unclassified"}
  defp default_classify({:error, _reason}), do: {:error, "unclassified"}
  defp default_classify(_result), do: :ok

  defp parent_id([{op_id, _late} | _rest]), do: op_id
  defp parent_id([]), do: nil

  defp finish_op(name, fields, outcome, op_id, parent, started) do
    {outcome_name, code} =
      case outcome do
        :ok -> {"ok", nil}
        {:expected, code} -> {"expected", code}
        {:error, code} -> {"error", code}
      end

    violate(
      Check.event_problems(name, "op", fields) ++ Check.reason_problems(name, code, outcome_name)
    )

    own =
      %{
        "outcome" => outcome_name,
        "duration_ms" => System.monotonic_time(:millisecond) - started,
        "op_id" => op_id
      }
      |> put_present("reason_code", code)
      |> put_present("parent_op_id", parent)

    send_record("op", name, fields, own)
  end

  @doc "Records a state change, checked against the machine's declared edges and triggers."
  @spec transition(String.t(), String.t(), String.t(), String.t(), fields(),
          reason: String.t(),
          duration_ms: non_neg_integer()
        ) :: :ok
  def transition(machine, from, to, trigger, fields \\ %{}, options \\ []) do
    fields = normalize(fields)
    reason = Keyword.get(options, :reason)

    violate(
      Check.field_problems(machine, fields, %{}) ++
        Check.machine_problems(machine, from, to, trigger) ++
        Check.reason_problems(machine, reason, nil)
    )

    own =
      %{"machine" => machine, "from_state" => from, "to_state" => to, "trigger" => trigger}
      |> put_present("reason_code", reason)
      |> put_present("duration_ms", Keyword.get(options, :duration_ms))

    send_record("transition", machine, fields, own)
  end

  @doc "Records an authoritative decision and returns its decision_id. Call it after the decision commits."
  @spec decision(String.t(), String.t(), fields(), String.t() | nil) :: String.t()
  def decision(name, decision, fields, reason \\ nil) do
    fields = normalize(fields)

    violate(
      Check.event_problems(name, "decision", fields) ++
        Check.decision_problems(name, decision) ++ Check.reason_problems(name, reason, nil)
    )

    decision_id = uuid()

    send_record(
      "decision",
      name,
      fields,
      put_present(%{"decision" => decision, "decision_id" => decision_id}, "reason_code", reason)
    )

    decision_id
  end

  @doc "Records that a surface was shown, and returns the function that records its dismissal once."
  @spec surface(String.t(), fields()) :: (-> :ok)
  def surface(name, fields) do
    fields = normalize(fields)
    violate(Check.event_problems(name, "surface", fields))
    shown = System.monotonic_time(:millisecond)
    send_record("surface", name, fields, %{"surface_state" => "shown"})
    done = :atomics.new(1, [])

    fn ->
      if :atomics.compare_exchange(done, 1, 0, 1) == :ok do
        send_record("surface", name, fields, %{
          "surface_state" => "dismissed",
          "shown_ms" => System.monotonic_time(:millisecond) - shown
        })
      end

      :ok
    end
  end

  @doc "Records a measurement or an observation."
  @spec fact(String.t(), fields()) :: :ok
  def fact(name, fields) do
    fields = normalize(fields)
    violate(Check.event_problems(name, "fact", fields))
    send_record("fact", name, fields, %{})
  end

  @doc "Records the full flags map and stamps its hash on every later record. Call it at boot and on change."
  @spec set_flags(%{optional(String.t()) => String.t() | boolean() | integer() | nil}) :: :ok
  def set_flags(flags) do
    case Flags.hash(flags) do
      {:ok, hash} ->
        :persistent_term.put(@flags_hash, hash)
        send_record("fact", "obs.flags_snapshot", %{"flags" => flags}, %{})

      {:error, problem} ->
        violate([problem])
    end
  end

  @doc "Violations counted in open mode, and records the telemetry handlers failed to take."
  @spec stats() :: %{violations: non_neg_integer(), export_failures: non_neg_integer()}
  def stats do
    counters = :persistent_term.get(@counters)

    %{
      violations: :atomics.get(counters, @violations),
      export_failures: :atomics.get(counters, @export_failures)
    }
  end

  defp config, do: Application.get_env(:chalk_sync, __MODULE__, [])

  defp closed? do
    case Keyword.get(config(), :mode, :auto) do
      :auto -> System.get_env("CHALK_OBS_MODE") == "closed"
      mode -> mode == :closed
    end
  end

  defp violate([]), do: :ok

  defp violate(problems) do
    if closed?(), do: raise(Violation, problems: problems)
    :atomics.add(:persistent_term.get(@counters), @violations, length(problems))
  end

  defp send_record(kind, name, fields, own) do
    config = config()
    env = Keyword.get(config, :env, "local")
    counters = :persistent_term.get(@counters)

    envelope =
      %{
        "event_id" => Keyword.get(config, :event_id, &uuid/0).(),
        "seq" => Keyword.get(config, :seq, fn -> :atomics.add_get(counters, @seq, 1) end).(),
        "source_id" => Keyword.get(config, :source_id) || :persistent_term.get(@source_id),
        "schema_ver" => Registry.schema_ver(),
        "module" => "sync",
        "env" => env,
        "platform" => "server",
        "clock_state" => "server",
        "est_server_ms" => Keyword.get(config, :clock, &system_ms/0).()
      }
      |> put_present("release_sha", Keyword.get(config, :release_sha))
      |> put_present("flags_hash", :persistent_term.get(@flags_hash, nil))

    unless env in Registry.environments(),
      do: violate(["obs config needs a registry env, not #{inspect(env)}"])

    record =
      fields
      |> Map.merge(envelope)
      |> Map.merge(own)
      |> Map.merge(%{"kind" => kind, "name" => name})

    try do
      :telemetry.execute(@event, %{seq: record["seq"]}, record)
    rescue
      exception ->
        if closed?(),
          do: reraise(exception, __STACKTRACE__),
          else: :atomics.add(counters, @export_failures, 1)
    end

    :ok
  end

  defp system_ms, do: System.system_time(:millisecond)

  defp normalize(fields), do: Map.new(fields, fn {field, value} -> {to_string(field), value} end)

  defp put_present(map, _key, nil), do: map
  defp put_present(map, key, value), do: Map.put(map, key, value)

  defp uuid do
    <<a::48, _version::4, b::12, _variant::2, c::62>> = :crypto.strong_rand_bytes(16)
    <<a::48, 4::4, b::12, 2::2, c::62>> |> Base.encode16(case: :lower) |> format_uuid()
  end

  defp format_uuid(<<a::binary-8, b::binary-4, c::binary-4, d::binary-4, e::binary-12>>),
    do: Enum.join([a, b, c, d, e], "-")
end
