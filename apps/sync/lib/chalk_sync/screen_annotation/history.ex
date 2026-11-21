defmodule ChalkSync.ScreenAnnotation.History do
  @moduledoc "Bounded per-contributor history that reserves IDs and replays exact mark versions."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema

  @limits Schema.limits()
  @empty %{"undo" => [], "redo" => []}

  def has_actions?(history, actor), do: stacks(history, actor) != @empty

  def reserved?(history, mark_id) do
    Enum.any?(history, fn {_actor, %{"undo" => undo, "redo" => redo}} ->
      Enum.any?(undo, &mark_id?(&1, mark_id)) or Enum.any?(redo, &mark_id?(&1, mark_id))
    end)
  end

  def remember(history, actor, kind, mark) do
    action = %{"kind" => kind, "mark" => mark}
    undo = Enum.take([action | stacks(history, actor)["undo"]], @limits["retainedUndoPerPerson"])
    put_stacks(history, actor, %{"undo" => undo, "redo" => []})
  end

  def drop_redo(history, actor),
    do: put_stacks(history, actor, %{stacks(history, actor) | "redo" => []})

  def purge(history, matches) do
    Enum.reduce(history, %{}, fn {actor, stacks}, retained ->
      next =
        Map.new(stacks, fn {key, actions} ->
          {key, Enum.reject(actions, &matches.(&1["mark"]))}
        end)

      put_stacks(retained, actor, next)
    end)
  end

  def replay(history, marks, actor, key) do
    stacks = stacks(history, actor)
    {remaining, effect} = next_effect(stacks[key], marks, actor, key)

    case effect do
      nil ->
        {put_stacks(history, actor, Map.put(stacks, key, [])), nil}

      {action, change} ->
        reverse = if key == "undo", do: "redo", else: "undo"
        next = stacks |> Map.put(key, remaining) |> Map.update!(reverse, &[action | &1])
        {put_stacks(history, actor, next), change}
    end
  end

  defp next_effect([], _marks, _actor, _key), do: {[], nil}

  defp next_effect([%{"kind" => kind, "mark" => mark} = action | rest], marks, actor, key) do
    id = mark["draft"]["mark_id"]

    # Older servers could reuse an ID while history still referred to it.
    # Skip obsolete entries instead of moving them to the opposite stack.
    case {mark["author"]["participant_id"], key, kind, marks[id]} do
      {^actor, "undo", "remove", nil} -> {rest, {action, {:upsert, mark}}}
      {^actor, "redo", "upsert", nil} -> {rest, {action, {:upsert, mark}}}
      {^actor, "undo", "upsert", ^mark} -> {rest, {action, {:remove, id}}}
      {^actor, "redo", "remove", ^mark} -> {rest, {action, {:remove, id}}}
      _obsolete -> next_effect(rest, marks, actor, key)
    end
  end

  defp mark_id?(%{"mark" => %{"draft" => %{"mark_id" => id}}}, id), do: true
  defp mark_id?(_action, _id), do: false

  defp stacks(history, actor), do: Map.get(history, actor, @empty)
  defp put_stacks(history, actor, @empty), do: Map.delete(history, actor)
  defp put_stacks(history, actor, stacks), do: Map.put(history, actor, stacks)
end
