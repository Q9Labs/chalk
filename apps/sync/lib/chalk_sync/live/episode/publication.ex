defmodule ChalkSync.Live.Episode.Publication do
  @moduledoc """
  Live target changes: enable a publication through the media plane, grant it and keep or release its screen lease.
  """

  alias ChalkSync.Live.Episode.MediaObservation
  alias ChalkSync.Live.Episode.ScreenLeases
  alias ChalkSync.Live.MediaPlaneCall
  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder
  alias ChalkSync.Telemetry

  def apply_live_target(state, identity, authority, source, %{enabled: true} = target) do
    {next, result} = enable_publication(state, identity, authority, source, target)

    if source in [:camera, :microphone, :screen] and
         result["outcome"] in ["confirmed", "satisfied"] do
      key = {authority.participant_id, Atom.to_string(source)}
      cleared = timed(:clear_pause, fn -> Stateholder.set_media_pause(identity, source, nil) end)

      case cleared do
        :ok -> {%{next | media_pauses: Map.delete(next.media_pauses, key)}, result}
        {:retryable, reason} -> {next, live_result(target, :retryable_failure, reason)}
        {:error, reason} -> {next, live_result(target, :terminal_failure, reason)}
      end
    else
      {next, result}
    end
  end

  def apply_live_target(state, identity, authority, source, target)
       when source in [:camera, :microphone, :screen] do
    key = {authority.participant_id, Atom.to_string(source)}

    publication_id =
      case Enum.find(state.media_observed_items, fn item ->
             item["participant_id"] == authority.participant_id and
               item["source"] ==
                 Atom.to_string(source)
           end) do
        %{"publication_id" => value} when is_binary(value) -> value
        _ -> nil
      end

    if is_binary(publication_id) do
      case Stateholder.set_media_pause(identity, source, publication_id) do
        :ok ->
          pauses = Map.put(state.media_pauses, key, publication_id)
          next = %{state | media_pauses: pauses}
          next = ScreenLeases.maybe_release_screen_lease(next, authority, source, false, :confirmed)
          {next, live_result(target, :confirmed)}

        {:retryable, reason} ->
          {state, live_result(target, :retryable_failure, reason)}

        {:error, reason} ->
          {state, live_result(target, :terminal_failure, reason)}
      end
    else
      next = ScreenLeases.maybe_release_screen_lease(state, authority, source, false, :confirmed)
      {next, live_result(target, :confirmed)}
    end
  end


  defp enable_publication(state, identity, authority, source, target) do
    with {module, adapter} <- MediaObservation.media_plane(authority) || {:error, :dependency_unavailable},
         {:ok, reservation} <-
           timed(:reserve, fn ->
             Stateholder.reserve_publication_grant(identity, target.operation_id, source)
           end) do
      enable_reserved_publication(
        state,
        authority,
        source,
        target,
        reservation,
        module,
        adapter
      )
    else
      {:retryable, reason} -> {state, live_result(target, :retryable_failure, reason)}
      {:error, reason} -> {state, live_result(target, :terminal_failure, reason)}
    end
  end


  defp enable_reserved_publication(
         state,
         authority,
         :screen,
         target,
         reservation,
         module,
         adapter
       ) do
    case ScreenLeases.acquire_screen_lease(state, authority, target.operation_id) do
      {:ok, lease} ->
        outcome =
          if ScreenLeases.screen_observed?(state.media_items, authority.participant_id),
            do: :satisfied,
            else:
              grant(module, adapter, state, authority, :screen, target.operation_id, reservation)

        {reported, retain?} = complete_grant(state, reservation, outcome)
        retain_or_release_screen_lease(state, authority, lease, retain?, target, reported)

      {:error, reason} ->
        _ = complete_grant(state, reservation, {:terminal_failure, reason})
        {state, screen_lease_failure(target, reason)}
    end
  end

  defp enable_reserved_publication(
         state,
         authority,
         source,
         target,
         reservation,
         module,
         adapter
       ) do
    outcome = grant(module, adapter, state, authority, source, target.operation_id, reservation)
    {reported, _retain?} = complete_grant(state, reservation, outcome)
    {state, live_result(target, reported)}
  end


  defp timed(stage, fun), do: Telemetry.timed([:live_target, :stage], stage, fun)


  defp grant(module, adapter, state, authority, source, operation_id, reservation) do
    {module, adapter} =
      ProviderCall.attach({module, adapter}, %{control_revision: reservation.control_revision})

    timed(:grant, fn ->
      MediaPlaneCall.invoke(fn ->
        module.grant_publication(
          adapter,
          operation_id,
          state.episode,
          authority.participant_id,
          source
        )
      end)
    end)
    |> provider_outcome()
  end


  defp complete_grant(state, reservation, outcome) do
    completion =
      timed(:complete, fn ->
        Stateholder.complete_publication_grant(
          state.episode,
          reservation.reservation_id,
          outcome
        )
      end)

    completed_grant_result(outcome, completion)
  end


  defp completed_grant_result(outcome, {:ok, %{result: :authorized}}),
    do: {retryable_provider_outcome(outcome), retain_grant_authority?(outcome)}

  defp completed_grant_result(_outcome, {:ok, %{result: :cleanup_required}}),
    do: {{:terminal_failure, :authority_changed}, false}

  defp completed_grant_result(_outcome, {:retryable, reason}),
    do: {{:retryable_failure, reason}, true}

  defp completed_grant_result(_outcome, {:error, _reason}),
    do: {{:terminal_failure, :authority_changed}, false}


  defp retryable_provider_outcome(:ambiguous),
    do: {:retryable_failure, :dependency_unavailable}

  defp retryable_provider_outcome(outcome), do: outcome


  defp provider_outcome({:error, reason}), do: {:retryable_failure, reason}
  defp provider_outcome(outcome), do: outcome


  defp retain_grant_authority?({:terminal_failure, _reason}), do: false
  defp retain_grant_authority?(_outcome), do: true


  defp retain_or_release_screen_lease(state, authority, lease, true, target, outcome) do
    leases = Map.put(state.screen_leases, authority.participant_id, lease)
    {%{state | screen_leases: leases}, live_result(target, outcome)}
  end

  defp retain_or_release_screen_lease(state, _authority, lease, false, target, outcome) do
    _ = ScreenLeases.release_screen_lease(state, lease)
    {state, live_result(target, outcome)}
  end


  defp screen_lease_failure(target, :dependency_unavailable),
    do: live_result(target, :retryable_failure, :dependency_unavailable)

  defp screen_lease_failure(target, reason),
    do: live_result(target, :terminal_failure, reason)


  defp name_string(name) when is_atom(name), do: Atom.to_string(name)
  defp name_string(name) when is_binary(name), do: name


  def live_result(target, {outcome, error_code})
       when outcome in [:retryable_failure, :terminal_failure],
       do: live_result(target, outcome, error_code)

  def live_result(target, outcome), do: live_result(target, outcome, nil)

  def live_result(target, outcome, error_code) do
    %{
      "type" => "live_target_result",
      "operation_id" => target.operation_id,
      "name" => name_string(target.name),
      "outcome" => Atom.to_string(outcome),
      "error_code" => error_code && Atom.to_string(error_code)
    }
  end
end
