defmodule ChalkSync.SyncBreaker.Generator do
  @moduledoc """
  Seeded generator for reproducible, fully materialized breaker histories.

  `generate/2` returns plain data for every selected operation and every model
  observation. Re-running it with the same seed and options returns the same
  scenario without relying on process scheduling or global random state.
  """

  alias ChalkSync.SyncBreaker.History.Record
  alias ChalkSync.SyncBreaker.Model
  alias ChalkSync.SyncBreaker.Operation

  @default_operation_count 24
  @default_participant_count 3

  @spec generate(non_neg_integer(), keyword()) :: %{
          seed: non_neg_integer(),
          operations: [Operation.t()],
          history: [Record.t()],
          snapshot: map()
        }
  def generate(seed, options \\ []) when is_integer(seed) and seed >= 0 do
    operation_count = Keyword.get(options, :operations, @default_operation_count)
    participant_count = Keyword.get(options, :participants, @default_participant_count)
    random_state = :rand.seed_s(:exsplus, random_seed(seed))

    {operations, _random_state} =
      participant_ids(participant_count)
      |> joined_operations()
      |> extend_operations(operation_count, random_state)

    {history, state, next_sequence} = materialize(operations)
    events = for %Record{kind: :event, event: event} <- history, do: event
    snapshot = Model.snapshot(state)

    history =
      history ++
        [
          Record.snapshot(next_sequence, snapshot),
          Record.replay(next_sequence + 1, 0, events, state.revision, snapshot)
        ]

    %{seed: seed, operations: operations, history: history, snapshot: snapshot}
  end

  defp participant_ids(count) when is_integer(count) and count > 0 do
    Enum.map(1..count, &"participant-#{&1}")
  end

  defp participant_ids(_count), do: ["participant-1"]

  defp joined_operations(participant_ids) do
    participant_ids
    |> Enum.with_index(1)
    |> Enum.map(fn {actor, id} ->
      Operation.new(id, actor, "command-#{id}", :join, %{display_name: "Participant #{id}"})
    end)
  end

  defp extend_operations(seed_operations, operation_count, random_state) do
    extra_count = max(operation_count - length(seed_operations), 0)
    actors = Enum.map(seed_operations, & &1.actor)

    if extra_count == 0 do
      {seed_operations, random_state}
    else
      Enum.reduce(1..extra_count, {seed_operations, random_state}, fn offset,
                                                                      {operations, state} ->
        id = length(operations) + 1
        {operation, next_state} = next_operation(id, actors, operations, state, offset)
        {operations ++ [operation], next_state}
      end)
    end
  end

  defp next_operation(id, actors, operations, random_state, _offset) do
    {choice, random_state} = random_integer(random_state, 10)

    if choice == 1 do
      retry = Enum.at(operations, rem(id * 7, length(operations)))
      {Operation.new(id, retry.actor, retry.command_id, retry.name, retry.payload), random_state}
    else
      {actor, random_state} = random_member(actors, random_state)

      {name, random_state} =
        random_member([:raise_hand, :lower_hand, :leave, :join, :unknown], random_state)

      payload = if name == :join, do: %{display_name: "Rejoin #{id}"}, else: %{}
      {Operation.new(id, actor, "command-#{id}", name, payload), random_state}
    end
  end

  defp materialize(operations) do
    operations
    |> Enum.reduce({[], Model.new(), 1}, fn operation, {history, state, sequence} ->
      invoke = Record.invoke(sequence, operation)

      case Model.apply(state, operation) do
        {:committed, event, next_state} ->
          records = [
            invoke,
            Record.event(sequence + 1, operation, event),
            Record.complete(sequence + 2, operation, {:committed, event.revision})
          ]

          {history ++ records, next_state, sequence + 3}

        {:duplicate, revision, next_state} ->
          records = [invoke, Record.complete(sequence + 1, operation, {:duplicate, revision})]
          {history ++ records, next_state, sequence + 2}

        {:rejected, reason, next_state} ->
          records = [invoke, Record.complete(sequence + 1, operation, {:rejected, reason})]
          {history ++ records, next_state, sequence + 2}
      end
    end)
  end

  defp random_seed(seed) do
    base = seed + 1
    {base, base * 17 + 3, base * 31 + 7}
  end

  defp random_member(items, random_state) do
    {index, random_state} = random_integer(random_state, length(items))
    {Enum.at(items, index - 1), random_state}
  end

  defp random_integer(random_state, maximum) do
    :rand.uniform_s(maximum, random_state)
  end
end
