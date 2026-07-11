defmodule ChalkSync.SyncBreaker.Operation do
  @moduledoc """
  A fully materialized control operation used by the sync breaker.

  `id` identifies one invocation. Retried operations receive a new `id` while
  retaining the original actor, command ID, name, and payload.
  """

  @enforce_keys [:id, :actor, :command_id, :name]
  defstruct [:id, :actor, :command_id, :name, payload: %{}]

  @type t :: %__MODULE__{
          id: pos_integer(),
          actor: String.t(),
          command_id: String.t(),
          name: atom(),
          payload: map()
        }

  @spec new(pos_integer(), String.t(), String.t(), atom(), map()) :: t()
  def new(id, actor, command_id, name, payload \\ %{}) do
    %__MODULE__{id: id, actor: actor, command_id: command_id, name: name, payload: payload}
  end

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = operation) do
    %{
      "id" => operation.id,
      "actor" => operation.actor,
      "command_id" => operation.command_id,
      "name" => Atom.to_string(operation.name),
      "payload" => operation.payload
    }
  end
end

defmodule ChalkSync.SyncBreaker.History.Record do
  @moduledoc """
  One ordered observation from a deterministic breaker run.

  An operation is represented by an `:invoke` record and a `:complete` record.
  Committed events point back to their source operation with `operation_id`.
  Snapshot and replay records retain the evidence needed for offline checking.
  """

  alias ChalkSync.SyncBreaker.Operation

  @enforce_keys [:seq, :kind]
  defstruct [
    :seq,
    :kind,
    :operation_id,
    :actor,
    :command_id,
    :outcome,
    :event,
    :snapshot,
    :events,
    :cursor,
    :control_revision,
    metadata: %{}
  ]

  @type outcome :: {:committed, pos_integer()} | {:duplicate, pos_integer()} | {:rejected, atom()}

  @type t :: %__MODULE__{
          seq: pos_integer(),
          kind: :invoke | :complete | :event | :snapshot | :replay,
          operation_id: pos_integer() | nil,
          actor: String.t() | nil,
          command_id: String.t() | nil,
          outcome: outcome() | nil,
          event: map() | nil,
          snapshot: map() | nil,
          events: [map()] | nil,
          cursor: non_neg_integer() | nil,
          control_revision: non_neg_integer() | nil,
          metadata: map()
        }

  @spec invoke(pos_integer(), Operation.t()) :: t()
  def invoke(seq, %Operation{} = operation) do
    %__MODULE__{
      seq: seq,
      kind: :invoke,
      operation_id: operation.id,
      actor: operation.actor,
      command_id: operation.command_id,
      metadata: %{name: operation.name, payload: operation.payload}
    }
  end

  @spec complete(pos_integer(), Operation.t(), outcome()) :: t()
  def complete(seq, %Operation{} = operation, outcome) do
    %__MODULE__{
      seq: seq,
      kind: :complete,
      operation_id: operation.id,
      actor: operation.actor,
      command_id: operation.command_id,
      outcome: outcome
    }
  end

  @spec event(pos_integer(), Operation.t(), map()) :: t()
  def event(seq, %Operation{} = operation, event) do
    %__MODULE__{
      seq: seq,
      kind: :event,
      operation_id: operation.id,
      actor: operation.actor,
      command_id: operation.command_id,
      event: event
    }
  end

  @spec snapshot(pos_integer(), map()) :: t()
  def snapshot(seq, snapshot) do
    %__MODULE__{seq: seq, kind: :snapshot, snapshot: snapshot}
  end

  @spec replay(pos_integer(), non_neg_integer(), [map()], non_neg_integer(), map()) :: t()
  def replay(seq, cursor, events, control_revision, snapshot) do
    %__MODULE__{
      seq: seq,
      kind: :replay,
      cursor: cursor,
      events: events,
      control_revision: control_revision,
      snapshot: snapshot
    }
  end

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = record) do
    %{"seq" => record.seq, "kind" => Atom.to_string(record.kind)}
    |> put_if_present("operation_id", record.operation_id)
    |> put_if_present("actor", record.actor)
    |> put_if_present("command_id", record.command_id)
    |> put_if_present("outcome", outcome_to_map(record.outcome))
    |> put_if_present("event", stringify_keys(record.event))
    |> put_if_present("snapshot", record.snapshot)
    |> put_if_present("events", events_to_map(record.events))
    |> put_if_present("cursor", record.cursor)
    |> put_if_present("control_revision", record.control_revision)
    |> put_if_present("metadata", stringify_keys(record.metadata))
  end

  defp outcome_to_map(nil), do: nil

  defp outcome_to_map({result, value}) do
    %{"result" => Atom.to_string(result), outcome_key(result) => stringify_keys(value)}
  end

  defp outcome_key(result) when result in [:committed, :duplicate], do: "revision"
  defp outcome_key(:rejected), do: "reason"

  defp events_to_map(nil), do: nil
  defp events_to_map(events), do: Enum.map(events, &stringify_keys/1)

  defp put_if_present(map, _key, nil), do: map
  defp put_if_present(map, key, value), do: Map.put(map, key, value)

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), stringify_keys(value)} end)
  end

  defp stringify_keys(list) when is_list(list), do: Enum.map(list, &stringify_keys/1)
  defp stringify_keys(value) when is_boolean(value) or is_nil(value), do: value
  defp stringify_keys(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify_keys(value), do: value
end
