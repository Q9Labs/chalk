defmodule ChalkSync.Retention.CleanupWorkerCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Retention.CleanupWorker
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @now ~U[2026-07-12 00:00:00.000000Z]

  using do
    quote do
      import ChalkSync.Retention.CleanupWorkerCase
    end
  end

  defp database_url do
    System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
      System.get_env("CHALK_DATABASE_URL")
  end

  setup_all do
    if database_url() do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(database_url())
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        SyncPostgres.restore_env(:database_connections, previous_connections)
        Enum.each(connections, &TestProcess.stop/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  def seed_ended_episode(connection, age_seconds) do
    fixture = SyncPostgres.seed_pending_join(connection)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert {:ok, operation} = Operation.new("retention_episode_end", :end_episode, %{})

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(fixture.identity, operation)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    age_ended_episode(connection, fixture, age_seconds)

    fixture
  end

  def seed_shared_episode(connection, fixture) do
    episode_id = UUID.generate()
    participant_id = UUID.generate()
    role_capabilities = Reducer.new(episode_id).role_capabilities

    episode = %{
      tenant_id: fixture.episode.tenant_id,
      space_id: fixture.episode.space_id,
      episode_id: episode_id
    }

    Postgrex.query!(
      connection,
      """
      insert into episodes (id, status, space_id, tenant_id, started_at, config_snapshot)
      values ($1, 'active', $2, $3, $4, $5)
      """,
      [
        UUID.dump!(episode_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.tenant_id),
        @now,
        %{
          "roles" => role_capabilities,
          "admission_policy" => %{"mode" => "open"},
          "default_episode_duration_seconds" => 86_400,
          "maximum_episode_duration_seconds" => 86_400
        }
      ]
    )

    Postgrex.query!(
      connection,
      """
      insert into participants (
        id, name, capabilities, tenant_id, space_id, episode_id,
        generation, status, joined_at, role
      ) values ($1, 'Newer Participant', $2, $3, $4, $5, 1, 'active', $6, 'owner')
      """,
      [
        UUID.dump!(participant_id),
        role_capabilities["owner"],
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        @now
      ]
    )

    Map.put(episode, :participant_id, participant_id)
  end

  def synchronize_event_counters(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_episode_control control
      set participant_event_count = event.participant_count,
          participant_event_bytes = event.participant_bytes,
          lifecycle_event_count = event.lifecycle_count,
          lifecycle_event_bytes = event.lifecycle_bytes
      from (
        select
          count(*) filter (where lifecycle_intent_id is null) as participant_count,
          coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is null), 0) as participant_bytes,
          count(*) filter (where lifecycle_intent_id is not null) as lifecycle_count,
          coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is not null), 0) as lifecycle_bytes
        from sync_control_events
        where tenant_id = $1 and episode_id = $2
      ) event
      where control.tenant_id = $1 and control.episode_id = $2
      """,
      episode_ids(fixture)
    )
  end

  def age_ended_episode(connection, fixture, age_seconds) do
    ended_at = DateTime.add(@now, -age_seconds, :second)

    Postgrex.query!(
      connection,
      "update episodes set ended_at = $3 where tenant_id = $1 and id = $2",
      episode_ids(fixture) ++ [ended_at]
    )
  end

  def operation(request_key, name, payload) do
    {:ok, operation} = Operation.new(request_key, name, payload)
    operation
  end

  def run_cleanup(connection, options \\ []) do
    CleanupWorker.run_once(connection, Keyword.put(options, :clock, fn -> @now end))
  end

  def cleaned_at(connection, fixture) do
    Postgrex.query!(
      connection,
      "select retention_cleaned_at from sync_episode_control where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    ).rows
  end

  def chat_stream_state(connection, fixture) do
    [[head, floor, count, bytes]] =
      Postgrex.query!(
        connection,
        """
        select head_sequence, retained_floor_sequence, message_count, message_bytes
        from sync_chat_streams where tenant_id = $1 and space_id = $2
        """,
        space_scope(fixture)
      ).rows

    [head, floor, count, bytes]
  end

  def checkpointed?(connection, fixture), do: cleaned_at(connection, fixture) != [[nil]]

  def cleanup_fixture(connection, fixture) do
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
  end

  def episode_ids(fixture),
    do: [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.episode_id)]

  def episode_scope(fixture),
    do: [
      UUID.dump!(fixture.episode.tenant_id),
      UUID.dump!(fixture.episode.space_id),
      UUID.dump!(fixture.episode.episode_id)
    ]

  def space_scope(fixture),
    do: [UUID.dump!(fixture.episode.tenant_id), UUID.dump!(fixture.episode.space_id)]
end
