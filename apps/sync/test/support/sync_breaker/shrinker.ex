defmodule ChalkSync.SyncBreaker.Shrinker do
  @moduledoc """
  Deterministic delta debugger for a failing operation list.

  The predicate receives candidate operation lists and returns true while the
  failure remains reproducible. `shrink/2` returns a one-minimal counterexample
  under contiguous-chunk deletion.
  """

  @spec shrink([term()], ([term()] -> boolean())) :: [term()]
  def shrink(operations, reproduces_failure?)
      when is_list(operations) and is_function(reproduces_failure?, 1) do
    if reproduces_failure?.(operations) do
      do_shrink(operations, 2, reproduces_failure?)
    else
      raise ArgumentError, "the supplied operation list does not reproduce the failure"
    end
  end

  defp do_shrink(operations, _granularity, _reproduces_failure?) when length(operations) < 2,
    do: operations

  defp do_shrink(operations, granularity, reproduces_failure?) do
    case removable_chunk(operations, granularity, reproduces_failure?) do
      {:ok, reduced} ->
        do_shrink(reduced, max(granularity - 1, 2), reproduces_failure?)

      :none when granularity >= length(operations) ->
        operations

      :none ->
        do_shrink(operations, min(length(operations), granularity * 2), reproduces_failure?)
    end
  end

  defp removable_chunk(operations, granularity, reproduces_failure?) do
    chunk_size = ceil(length(operations) / granularity)

    operations
    |> Enum.chunk_every(chunk_size)
    |> Enum.with_index()
    |> Enum.reduce_while(:none, fn {chunk, index}, :none ->
      start = index * chunk_size
      candidate = Enum.take(operations, start) ++ Enum.drop(operations, start + length(chunk))

      if reproduces_failure?.(candidate) do
        {:halt, {:ok, candidate}}
      else
        {:cont, :none}
      end
    end)
  end
end
