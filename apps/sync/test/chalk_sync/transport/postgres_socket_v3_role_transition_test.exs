defmodule ChalkSync.Transport.PostgresSocketV3RoleTransitionTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  @role_capabilities %{
    "host" => ["publishAudio", "publishVideo", "publishScreen", "subscribe", "promoteDemote"],
    "cohost" => ["publishAudio", "publishVideo", "subscribe"],
    "participant" => ["subscribe"]
  }

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  test "pending role transition delivers its event before retryable ACK and polls terminal", %{
    connection: connection,
    port: port
  } do
    fixture = SyncPostgres.seed_session(connection, 2, %{role_capabilities: @role_capabilities})
    [host, guest] = fixture.identities
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    {:ok, promote} =
      Command.new("socket-role-promote1", :set_participant_role, %{
        "participantSessionId" => guest.participant_session_id,
        "role" => "cohost"
      })

    assert {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, promote, [])

    publication = %{
      participant_session_id: guest.participant_session_id,
      source: :camera,
      enabled: true,
      publication_id: "provider-camera-publication"
    }

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{observe_session_publications: {:ok, [publication]}}
      )

    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    client = connect_live(port, host)
    command = role_command("socket-role-demote01", guest.participant_session_id)
    client = Client.send_json(client, command)

    assert {:json,
            %{
              "type" => "event",
              "command_id" => "socket-role-demote01",
              "name" => "participant_role_changed"
            }, client} = Client.recv(client)

    assert {:json,
            %{
              "type" => "retryable_error",
              "command_id" => "socket-role-demote01",
              "code" => "external_operation_pending"
            }, client} = Client.recv(client)

    client = Client.send_json(client, command)

    assert {:json, %{"type" => "retryable_error", "code" => "external_operation_pending"}, client} =
             Client.recv(client)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    {_session, child} =
      Enum.find(claimed, fn {_session, operation} ->
        operation.source == :camera and
          operation.target_participant_session_id == guest.participant_session_id
      end)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.session,
               child.external_operation_id,
               {:confirmed, :provider}
             )

    client = Client.send_json(client, command)

    assert {:json,
            %{
              "type" => "ack",
              "command_id" => "socket-role-demote01",
              "delivery" => "duplicate",
              "outcome" => "committed"
            }, _client} = Client.recv(client)
  end

  defp connect_live(port, identity) do
    {:ok, client} = Client.connect(port, "/v3/sync")
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)
    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} = Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "presence"}, client} =
      Client.recv(client)

    client
  end

  defp role_command(command_id, participant_id) do
    %{
      "type" => "command",
      "command_id" => command_id,
      "name" => "set_participant_role",
      "payload" => %{
        "participant_session_id" => participant_id,
        "role" => "participant"
      }
    }
  end

  defp hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "initial_role" => identity.role,
        "eligible_roles" => identity.eligible_roles,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 3,
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
