defmodule ChalkSync.WhiteboardV1.DrawPolicyCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository

  using do
    quote do
      import ChalkSync.WhiteboardV1.DrawPolicyCase
    end
  end

  defp database_url do
    System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
      System.get_env("CHALK_DATABASE_URL")
  end

  setup_all do
    if database_url() do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      previous_repository = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
      connections = SyncPostgres.start_connections(database_url())
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      Application.put_env(
        :chalk_sync,
        :whiteboard_v1_repository,
        ChalkSync.WhiteboardV1.PostgresRepository
      )

      on_exit(fn ->
        SyncPostgres.restore_env(:database_connections, previous_connections)
        SyncPostgres.restore_env(:whiteboard_v1_repository, previous_repository)
        Enum.each(connections, &TestProcess.stop/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    connection = hd(connections)

    fixture =
      SyncPostgres.seed_episode(connection, 3, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}, %{role: "observer"}]
      })

    on_exit(fn ->
      cleanup_whiteboard(connection, fixture.episode)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    [host, collaborator, observer] = fixture.identities

    {:ok, episode: fixture.episode, host: host, collaborator: collaborator, observer: observer}
  end

  def can_draw?(identity) do
    {:ok, %{can_draw: can_draw}} = PostgresRepository.connect(identity)
    {:ok, %{can_draw: ^can_draw}} = PostgresRepository.draw_access(identity)
    can_draw
  end

  def set_policy(host, policy, operation_id) do
    assert {:ok, %{outcome: :committed}} =
             PostgresRepository.set_draw_policy(host, %{
               operation_id: operation_id,
               policy: policy
             })
  end

  def set_permission(host, target, can_draw, operation_id) do
    assert {:ok, %{outcome: :committed}} =
             PostgresRepository.set_draw_permission(host, %{
               operation_id: operation_id,
               participant_id: target.participant_id,
               can_draw: can_draw
             })
  end

  def draw(identity, operation_id) do
    {:ok, %{scene_id: scene_id}} = PostgresRepository.connect(identity)

    PostgresRepository.commit_update(identity, %{
      operation_id: operation_id,
      scene_id: scene_id,
      elements: [element(operation_id)]
    })
  end

  def element(id) do
    %{
      "id" => id,
      "type" => "rectangle",
      "version" => 1,
      "version_nonce" => 1,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{"x" => 10, "y" => 20, "width" => 100, "height" => 60}
    }
  end

  def cleanup_whiteboard(connection, episode) do
    params = [UUID.dump!(episode.tenant_id), UUID.dump!(episode.space_id)]

    Enum.each(
      [
        "sync_whiteboard_operation_receipts",
        "sync_whiteboard_permissions",
        "sync_whiteboard_draw_policies",
        "sync_whiteboard_draw_policy_receipts",
        "sync_whiteboard_elements",
        "sync_whiteboard_scenes"
      ],
      fn table ->
        Postgrex.query!(
          connection,
          "delete from #{table} where tenant_id = $1 and space_id = $2",
          params
        )
      end
    )
  end
end
