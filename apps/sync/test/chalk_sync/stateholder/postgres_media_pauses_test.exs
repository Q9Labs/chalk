defmodule ChalkSync.Stateholder.PostgresMediaPausesTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, fn connection ->
          if Process.alive?(connection), do: GenServer.stop(connection)
        end)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  test "a self-pause survives a fresh stateholder read and clears on re-enable", %{
    connection: connection
  } do
    fixture = SyncPostgres.seed_episode(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    identity = hd(fixture.identities)
    publication_id = "publisher-connection|camera-track"
    key = {identity.participant_id, "camera"}

    assert {:ok, %{}} = Postgres.media_pauses(fixture.episode)
    assert :ok = Postgres.set_media_pause(identity, :camera, publication_id)
    assert {:ok, %{^key => ^publication_id}} = Postgres.media_pauses(fixture.episode)
    assert :ok = Postgres.set_media_pause(identity, :camera, nil)
    assert {:ok, pauses} = Postgres.media_pauses(fixture.episode)
    refute Map.has_key?(pauses, key)
  end
end
