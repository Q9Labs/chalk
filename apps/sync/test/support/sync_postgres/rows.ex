defmodule ChalkSync.SyncPostgres.Rows do
  @moduledoc """
  Product rows shared by the Sync Postgres fixtures.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.UUID

  def insert_product_rows(connection, episode, participants, policy) do
    config_snapshot = episode_config_snapshot(episode.episode_id, policy)

    Postgrex.query!(
      connection,
      "insert into tenants (id, name) values ($1, 'Sync Test') on conflict (id) do nothing",
      [uuid(episode.tenant_id)]
    )

    Postgrex.query!(
      connection,
      """
      insert into spaces (id, name, tenant_id, slug, media_plane)
      values ($1, 'Sync Test Space', $2, $3, 'cf_rtk')
      on conflict (id) do nothing
      """,
      [uuid(episode.space_id), uuid(episode.tenant_id), "sync-test-#{episode.space_id}"]
    )

    Postgrex.query!(
      connection,
      """
      insert into episodes (
        id, status, space_id, tenant_id, started_at, config_snapshot
      ) values ($1, 'active', $2, $3, now(), $4)
      """,
      [
        uuid(episode.episode_id),
        uuid(episode.space_id),
        uuid(episode.tenant_id),
        config_snapshot
      ]
    )

    Enum.each(participants, fn participant ->
      Postgrex.query!(
        connection,
        """
        insert into participants (
          id, name, capabilities, tenant_id, space_id, episode_id,
          generation, status, joined_at, role
        ) values ($1, $2, $3, $4, $5, $6, $7, 'active', now(), $8)
        """,
        [
          uuid(participant.id),
          participant.display_name,
          participant.capabilities,
          uuid(episode.tenant_id),
          uuid(episode.space_id),
          uuid(episode.episode_id),
          participant.generation,
          participant.role
        ]
      )
    end)
  end

  def insert_control(connection, episode, policy) do
    state = Reducer.new(episode.episode_id, policy)

    Postgrex.query!(
      connection,
      """
      insert into sync_episode_control (
        tenant_id, space_id, episode_id, folded_state, state_schema_version,
        state_digest, snapshot_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7)
      """,
      [
        uuid(episode.tenant_id),
        uuid(episode.space_id),
        uuid(episode.episode_id),
        Reducer.snapshot(state),
        Reducer.state_schema_version(),
        Reducer.digest(state),
        Reducer.snapshot_bytes(state)
      ]
    )
  end

  defp episode_config_snapshot(episode_id, policy) do
    defaults = Reducer.new(episode_id).role_capabilities
    roles = Map.get(policy, :role_capabilities, Map.get(policy, "role_capabilities", defaults))

    artifact_policy =
      Map.get(
        policy,
        :artifact_policy,
        Map.get(policy, "artifact_policy", %{
          "schema_version" => "episode_config.v2",
          "recording" => %{
            "mode" => "automatic",
            "profile" => "composite_720p_v1",
            "retention_seconds" => 2_592_000
          },
          "transcription" => %{
            "mode" => "disabled",
            "retention_seconds" => 0,
            "source_window_seconds" => 0
          }
        })
      )

    admission_policy =
      Map.get(policy, :admission_policy, Map.get(policy, "admission_policy", "open"))

    admission_mode =
      if is_map(admission_policy),
        do: Map.get(admission_policy, "mode", "open"),
        else: admission_policy

    %{
      "roles" => roles,
      "admission_policy" => %{"mode" => admission_mode},
      "default_episode_duration_seconds" =>
        Map.get(policy, :default_episode_duration_seconds, 86_400),
      "maximum_episode_duration_seconds" =>
        Map.get(policy, :maximum_episode_duration_seconds, 86_400),
      "artifact_policy" => artifact_policy
    }
    |> Map.merge(Map.take(policy, ["linger_window_seconds"]))
  end

  def uuid(value), do: UUID.dump!(value)

  def nullable_uuid(nil), do: nil
  def nullable_uuid(value), do: uuid(value)
end
