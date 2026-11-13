defmodule ChalkSync.Live.MediaOffReasonCase do
  @moduledoc "Shared setup and helpers for the split test files."

  import ExUnit.Assertions

  import ExUnit.Callbacks

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer.Execution
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  defmacro __using__(_opts) do
    quote do
      import ChalkSync.Live.MediaOffReasonCase

      @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                      System.get_env("CHALK_DATABASE_URL")
      setup_all do
        connections = SyncPostgres.start_connections(@database_url, 4)

        previous =
          for key <- [:stateholder, :database_connections, :media_plane],
              into: %{},
              do: {key, Application.get_env(:chalk_sync, key)}

        Application.put_env(:chalk_sync, :stateholder, Postgres)

        Application.put_env(
          :chalk_sync,
          :database_connections,
          SyncPostgres.selector(connections)
        )

        {:ok, adapter} =
          MediaPlaneTestAdapter.start_link(outcomes: %{observe_episode_publications: {:ok, []}})

        Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

        on_exit(fn ->
          for {key, value} <- previous do
            if value,
              do: Application.put_env(:chalk_sync, key, value),
              else: Application.delete_env(:chalk_sync, key)
          end

          for pid <- connections, do: ChalkSync.TestProcess.stop(pid)
        end)

        {:ok, connection: hd(connections)}
      end

      setup %{connection: connection} do
        fixture =
          SyncPostgres.seed_episode(connection, 2, %{}, %{
            participants: [%{}, %{role: "collaborator"}]
          })

        on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
        [host, guest] = fixture.identities
        {:ok, fixture: fixture, host: host, guest: guest}
      end
    end
  end

  def accept_on(live, guest, operation_id \\ UUID.generate()) do
    {_next, result} = accept_on_state(live, guest, operation_id)
    result
  end

  def accept_on_state(live, guest, operation_id \\ UUID.generate()) do
    LiveEpisode.live_target(live, guest, %{
      name: :set_microphone_enabled,
      operation_id: operation_id,
      enabled: true
    })
  end

  def use_adapter(outcomes) do
    previous = Application.get_env(:chalk_sync, :media_plane)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: Map.put_new(outcomes, :observe_episode_publications, {:ok, []})
      )

    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})
    on_exit(fn -> Application.put_env(:chalk_sync, :media_plane, previous) end)
    adapter
  end

  def mute(host, guest) do
    {:ok, operation} =
      Operation.new("off_reason_mute_#{System.unique_integer([:positive])}", :mute_participant, %{
        "participantId" => guest.participant_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    {episode, external} =
      Enum.find(claimed, fn {_episode, candidate} ->
        candidate.external_operation_id == operation_id
      end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert :confirmed =
             Execution.execute_operation(
               episode,
               external,
               {MediaPlaneTestAdapter, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied, applied_revision: revision}} =
             Postgres.read_operation(guest.episode, operation_id)

    revision
  end

  def media_session(port, path, identity, cursor) do
    {:ok, client} = Client.connect(port, path)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], fn
            "control" -> {"control", %{"cursor" => cursor}}
            stream -> {stream, %{"cursor" => nil}}
          end)
      })

    assert {:json, %{"type" => "welcome"} = welcome, client} = Client.recv(client)
    assert welcome["mode"] == if(is_nil(cursor) or stale?(cursor), do: "snapshot", else: "replay")

    {items, client} = recv_media(client, welcome)

    Client.close_tcp(client)
    {welcome, items}
  end

  def stale?(%{"state_digest" => digest}), do: digest == String.duplicate("0", 64)

  def recv_media(client, %{"mode" => "snapshot"} = welcome),
    do: client |> Client.acknowledge_recovery(welcome) |> recv_media()

  def recv_media(client, %{"mode" => "replay"}) do
    assert {:json, %{"type" => "replay_page"} = page, client} = Client.recv(client)
    client |> Client.acknowledge_recovery(page) |> recv_media()
  end

  def recv_media(client) do
    case Client.recv(client) do
      {:json, %{"type" => "projection_snapshot", "stream" => "media", "items" => items}, client} ->
        {items, client}

      {:json, _other, client} ->
        recv_media(client)
    end
  end

  def token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end
end
