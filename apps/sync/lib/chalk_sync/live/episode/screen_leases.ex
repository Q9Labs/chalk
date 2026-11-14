defmodule ChalkSync.Live.Episode.ScreenLeases do
  @moduledoc """
  Screen-share leases an Episode holds: acquire, renew, rotate and release against the media observation.
  """

  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Postgres.ScreenShareLease
  alias ChalkSync.UUID

  def maybe_release_screen_lease(state, authority, :screen, false, outcome)
      when outcome in [:confirmed, :satisfied] do
    case Map.pop(state.screen_leases, authority.participant_id) do
      {nil, _leases} ->
        state

      {lease, leases} ->
        _ = release_screen_lease(state, lease)
        %{state | screen_leases: leases}
    end
  end

  def maybe_release_screen_lease(state, _authority, _source, _enabled, _outcome), do: state

  def reconcile_screen_leases(state, media_items, options, absent) do
    case observed_screen_participants(media_items) do
      [] ->
        settle_screen_leases(state, media_items, options, absent)

      [participant_id] ->
        reconcile_single_screen(state, media_items, participant_id, options, absent)

      _conflicting ->
        {:error, :conflicting_screen_publications}
    end
  end

  defp reconcile_single_screen(state, media_items, participant_id, options, absent) do
    with {:ok, state} <- settle_screen_leases(state, media_items, options, absent) do
      case Map.fetch(state.screen_leases, participant_id) do
        {:ok, _lease} -> {:ok, state}
        :error -> acquire_observed_screen_lease(state, participant_id, options)
      end
    end
  end

  defp settle_screen_leases(state, media_items, options, absent) do
    Enum.reduce_while(state.screen_leases, {:ok, state}, fn
      {participant_id, lease}, {:ok, current} ->
        result =
          cond do
            screen_observed?(media_items, participant_id) ->
              reconcile_observed_screen_lease(current, participant_id, lease, options)

            absent == :release_absent ->
              {:ok, release_and_forget_screen_lease(current, participant_id, lease)}

            true ->
              {:ok, current}
          end

        case result do
          {:ok, next} -> {:cont, {:ok, next}}
          {:error, _reason} = error -> {:halt, error}
        end
    end)
  end

  defp reconcile_observed_screen_lease(state, participant_id, lease, options) do
    case Stateholder.participant_authority(state.episode, participant_id, lease.owner_generation) do
      {:ok, %{generation: generation}} when generation == lease.owner_generation ->
        renew_screen_lease(state, participant_id, lease, options)

      {:retryable, reason} ->
        {:error, reason}

      _authority_changed ->
        {:ok, release_and_forget_screen_lease(state, participant_id, lease)}
    end
  end

  # A lease that its hard cap would end before the next look is replaced while the
  # share still runs, so the lease never lapses under a sharer.
  defp renew_screen_lease(state, participant_id, lease, options) do
    if ScreenShareLease.outlasts_renewal?(lease, options) do
      extend_screen_lease(state, participant_id, lease, options)
    else
      rotate_screen_lease(state, participant_id, lease, options)
    end
  end

  defp extend_screen_lease(state, participant_id, lease, options) do
    case Stateholder.renew_screen_lease(state.episode, lease, options) do
      {:ok, renewed} -> {:ok, put_lease(state, participant_id, renewed)}
      {:error, :lease_expired} -> rotate_screen_lease(state, participant_id, lease, options)
      {:error, reason} -> {:error, reason}
    end
  end

  defp rotate_screen_lease(state, participant_id, lease, options) do
    case Stateholder.acquire_screen_lease(
           state.episode,
           participant_id,
           lease.owner_generation,
           Keyword.put(options, :replace_own, true)
         ) do
      {:ok, rotated} -> {:ok, put_lease(state, participant_id, rotated)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp acquire_observed_screen_lease(state, participant_id, options) do
    with {:ok, authority} <- Stateholder.participant_authority(state.episode, participant_id, nil),
         {:ok, lease} <-
           Stateholder.acquire_screen_lease(
             state.episode,
             participant_id,
             authority.generation,
             options
           ) do
      {:ok, put_lease(state, participant_id, lease)}
    else
      {:retryable, reason} -> {:error, reason}
      {:error, reason} -> {:error, reason}
    end
  end

  defp put_lease(state, participant_id, lease),
    do: %{state | screen_leases: Map.put(state.screen_leases, participant_id, lease)}

  defp release_and_forget_screen_lease(state, participant_id, lease) do
    _ = release_screen_lease(state, lease)
    %{state | screen_leases: Map.delete(state.screen_leases, participant_id)}
  end

  def screen_observed?(media_items, participant_id) do
    Enum.any?(media_items, fn item ->
      item["participant_id"] == participant_id and item["source"] == "screen" and
        item["enabled"]
    end)
  end

  defp observed_screen_participants(media_items) do
    media_items
    |> Enum.filter(&(&1["source"] == "screen" and &1["enabled"]))
    |> Enum.map(& &1["participant_id"])
    |> Enum.uniq()
  end

  def acquire_screen_lease(state, authority, operation_id) do
    Stateholder.acquire_screen_lease(
      state.episode,
      authority.participant_id,
      authority.generation,
      [
        {:replace_own, not Map.has_key?(state.screen_leases, authority.participant_id)}
        | screen_lease_options(operation_id)
      ]
    )
  end

  defp screen_lease_options(operation_id) do
    cond do
      is_binary(operation_id) and byte_size(operation_id) == 16 ->
        [lease_id: UUID.load!(operation_id)]

      match?({:ok, _uuid}, UUID.dump(operation_id)) ->
        [lease_id: operation_id]

      true ->
        []
    end
  end

  def release_screen_lease(state, lease),
    do: Stateholder.release_screen_lease(state.episode, lease)
end
