defmodule ChalkSync.Live.Episode.MediaObservation do
  @moduledoc """
  What the media plane reports for an Episode: items, pauses, off reasons and the observation cursor.
  """

  alias ChalkSync.Live.Episode.Projections
  alias ChalkSync.Live.Episode.ScreenLeases
  alias ChalkSync.Live.MediaPlaneCall
  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder

  def refresh_media(state, options) do
    with {:ok, pauses} <- Stateholder.media_pauses(state.episode),
         {:ok, stops} <- Stateholder.media_stops(state.episode),
         {:ok, observation} <- observed_media(state) do
      apply_media_observation(
        %{state | media_pauses: pauses, media_stops: stops},
        observation,
        options
      )
    else
      {:retryable, _reason} -> {:error, :dependency_unavailable}
      error -> error
    end
  end

  defp apply_media_observation(state, observation, options) do
    cursor = {observation.incarnation, observation.sequence}

    case compare_media_cursor(cursor, state.media_observation_cursor) do
      :older ->
        {:ok, state, []}

      :equal ->
        apply_equal_media_observation(state, observation.publications)

      :newer ->
        apply_newer_media_observation(state, cursor, observation.publications, options)
    end
  end

  defp apply_equal_media_observation(state, publications) do
    observed_items = normalize_media_items(publications)

    if observed_items == state.media_observed_items do
      reconcile_observed_media(
        state,
        apply_media_pauses(observed_items, state.media_pauses, state.media_stops)
      )
    else
      {:error, :dependency_unavailable}
    end
  end

  defp apply_newer_media_observation(state, cursor, publications, options) do
    observed_items = normalize_media_items(publications)

    {_pauses, media_items} =
      projection = apply_media_pauses(observed_items, state.media_pauses, state.media_stops)

    with {:ok, next} <- ScreenLeases.reconcile_screen_leases(state, media_items, options) do
      next = %{next | media_observed_items: observed_items, media_observation_cursor: cursor}
      reconcile_observed_media(next, projection)
    end
  end

  defp reconcile_observed_media(state, {pauses, media_items}) do
    case Projections.reconcile_projection(:media, state.media_projection, media_items) do
      {:ok, projection, frames} ->
        {:ok,
         %{state | media_pauses: pauses, media_items: media_items, media_projection: projection},
         frames}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp apply_media_pauses(observed_items, pauses, stops) do
    retained =
      Enum.reduce(observed_items, %{}, fn item, retained ->
        key = {item["participant_id"], item["source"]}
        publication_id = item["publication_id"]

        if is_binary(publication_id) and Map.get(pauses, key) == publication_id,
          do: Map.put(retained, key, publication_id),
          else: retained
      end)

    projected =
      Enum.map(observed_items, fn item ->
        key = {item["participant_id"], item["source"]}

        if item["enabled"] and not Map.has_key?(retained, key),
          do: item,
          else: %{item | "enabled" => false, "publication_id" => nil}
      end)

    {retained, project_off_reasons(projected, retained, stops)}
  end

  # Says why an item is off: a host stop (with its revision) wins over a device pause.
  # A stop projects even when the media plane lists no publication, so a client that
  # missed the stop event still sees it. It also projects while another device of the
  # participant has a live publication, because that device's on answers the stop for
  # that device only; a device with an older intent must still see it. Everything else
  # stays without a reason.
  defp project_off_reasons(items, retained, stops) do
    listed = MapSet.new(items, &{&1["participant_id"], &1["source"]})

    unlisted =
      for {{participant_id, source} = key, _revision} <- stops, not MapSet.member?(listed, key) do
        %{
          "participant_id" => participant_id,
          "source" => source,
          "enabled" => false,
          "publication_id" => nil
        }
      end

    (items ++ unlisted)
    |> Enum.map(&put_off_reason(&1, retained, stops))
    |> Enum.sort_by(&{&1["participant_id"], &1["source"]})
  end

  defp put_off_reason(item, retained, stops) do
    key = {item["participant_id"], item["source"]}

    case Map.fetch(stops, key) do
      {:ok, revision} ->
        Map.merge(item, %{"off_reason" => "host", "off_revision" => revision})

      :error ->
        if item["enabled"] == false and Map.has_key?(retained, key),
          do: Map.put(item, "off_reason", "self"),
          else: item
    end
  end

  defp observed_media(state) do
    case media_plane() do
      nil ->
        {:ok, %{incarnation: 0, sequence: 0, publications: []}}

      {module, adapter} ->
        observe_media(module, adapter, state)
    end
  end

  defp observe_media(module, adapter, state) do
    MediaPlaneCall.invoke(fn ->
      module.observe_episode_publications(adapter, state.episode)
    end)
    |> observed_media_result()
  end

  defp observed_media_result(
         {:ok,
          %{incarnation: incarnation, sequence: sequence, publications: publications} =
            observation}
       )
       when is_integer(incarnation) and incarnation >= 0 and is_integer(sequence) and
              sequence >= 0 and is_list(publications) do
    {:ok, observation}
  end

  defp observed_media_result({:error, reason}), do: {:error, reason}
  defp observed_media_result(_invalid), do: {:error, :dependency_unavailable}

  defp normalize_media_items(publications) do
    publications
    # Older v1 SDKs reject unknown projection sources. Tab audio is discovered
    # through the SFU publication list and follows the screen's control state.
    |> Enum.reject(&(&1.source == :screen_audio))
    |> Enum.map(&media_item/1)
    |> Enum.sort_by(&{&1["participant_id"], &1["source"]})
  end

  defp compare_media_cursor(_cursor, nil), do: :newer
  defp compare_media_cursor(cursor, cursor), do: :equal
  defp compare_media_cursor(cursor, current) when cursor < current, do: :older
  defp compare_media_cursor(_cursor, _current), do: :newer

  defp media_item(item) do
    %{
      "participant_id" => item.participant_id,
      "source" => Atom.to_string(item.source),
      "enabled" => item.enabled,
      "publication_id" => item.publication_id
    }
  end

  def media_plane, do: Application.get_env(:chalk_sync, :media_plane)

  def media_plane(authority) do
    ProviderCall.attach(media_plane(), %{
      participant_id: authority.participant_id,
      participant_generation: authority.generation
    })
  end
end
