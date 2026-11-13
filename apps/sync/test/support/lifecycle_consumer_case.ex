defmodule ChalkSync.LifecycleConsumerCase do
  @moduledoc "Shared setup and helpers for the split test files."

  import ExUnit.Assertions

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  defmacro __using__(_opts) do
    quote do
      import ChalkSync.LifecycleConsumerCase

      @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                      System.get_env("CHALK_DATABASE_URL")
      setup_all do
        if @database_url do
          previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
          previous_connections = Application.get_env(:chalk_sync, :database_connections)
          connections = SyncPostgres.start_connections(@database_url)

          Application.put_env(:chalk_sync, :stateholder, Postgres)

          Application.put_env(
            :chalk_sync,
            :database_connections,
            SyncPostgres.selector(connections)
          )

          on_exit(fn ->
            Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
            SyncPostgres.restore_env(:database_connections, previous_connections)
            Enum.each(connections, &TestProcess.stop/1)
          end)

          {:ok, connections: connections}
        else
          :ok
        end
      end
    end
  end

  def entry_identity(identity, generation, old_token) do
    identity |> Map.put(:entry_generation, generation) |> Map.put(:entry_token_id, old_token)
  end

  def receive_entered_ack(client, remaining \\ 8)

  def receive_entered_ack(client, remaining) when remaining > 0 do
    case Client.recv(client) do
      {:json, %{"type" => "entered_ack"}, client} ->
        client

      {:json, %{"type" => "error"} = frame, _client} ->
        flunk("entered rejected: #{inspect(frame)}")

      {:json, _frame, client} ->
        receive_entered_ack(client, remaining - 1)
    end
  end

  def entry_row(connection, fixture) do
    Postgrex.query!(
      connection,
      "select p.status,s.state,p.first_joined_at is not null from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    ).rows
  end

  def hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.episode.tenant_id,
        "space_id" => identity.episode.space_id,
        "episode_id" => identity.episode.episode_id,
        "participant_id" => identity.participant_id,
        "participant_generation" => identity.participant_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "role" => identity.role || "owner",
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 1,
      "extensions" => [
        %{
          "name" => "collaboration_v2",
          "chat_cursor" => %{"after_sequence" => nil, "retained_floor_sequence" => nil}
        }
      ],
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end

  def managed_pending_join(connection) do
    fixture = SyncPostgres.seed_pending_join(connection)

    Postgrex.query!(
      connection,
      """
      insert into participant_join_seats(tenant_id,space_id,episode_id,participant_id,generation,state,expires_at,issued_entry_generation)
      values($1,$2,$3,$4,1,'pending',now()+interval '2 minutes',2)
      """,
      Scope.participant(fixture.identity)
    )

    Postgrex.query!(
      connection,
      "update participants set media_connection_id='attempt-old' where id=$1",
      [UUID.dump!(fixture.identity.participant_id)]
    )

    fixture
  end

  def seat_transition(connection, fixture, action) do
    Postgrex.query!(
      connection,
      "select transition_participant_join_seat($1,$2,$3,$4,1,$5,'attempt-old')",
      Scope.participant(fixture.identity) ++ [action]
    ).rows
  end
end
