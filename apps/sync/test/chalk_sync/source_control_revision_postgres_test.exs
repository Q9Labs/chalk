defmodule ChalkSync.SourceControlRevisionPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url, 2)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    fixture =
      SyncPostgres.seed_episode(connection, 2, %{}, %{
        participants: [%{}, %{role: "collaborator"}]
      })

    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    {:ok, fixture: fixture}
  end

  # A mute whose revoke reached the SFU but whose result was lost exhausts its retries and
  # fails without a control event. The Participant's next grant must still be strictly newer,
  # because the SFU recorded the revoke and lets a revoke win a tie.
  test "a grant after a stop that failed terminally is strictly newer and opens the source", %{
    connection: connection,
    fixture: fixture
  } do
    episode = fixture.episode
    [host, speaker] = fixture.identities
    {:ok, sfu} = Agent.start_link(fn -> nil end)

    adapter =
      Client.new!(base_url: "http://localhost:4000", transport: sfu_transport(sfu))
      |> MediaPlane.new!()

    first = grant(adapter, speaker, "revision_first_mic_0001")
    assert Agent.get(sfu, & &1) == {first.control_revision, :granted}

    {:ok, mute} =
      Operation.new("revision_lost_mute_0001", :mute_participant, %{
        "participantId" => speaker.participant_id
      })

    assert {:ok, %{result: :pending, external_operation_id: mute_id}} =
             Postgres.begin_operation(host, mute)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99,next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(mute_id)]
    )

    assert {:ok, operations} = Postgres.claim_operations(64)

    assert {^episode, stop} =
             Enum.find(operations, fn {_, op} -> op.external_operation_id == mute_id end)

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               episode,
               stop,
               {MediaPlane, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed}} = Postgres.read_operation(episode, mute_id)
    assert Agent.get(sfu, & &1) == {stop.control_revision, :revoked}

    second = grant(adapter, speaker, "revision_after_lost_mute")
    assert second.control_revision > stop.control_revision
    assert Agent.get(sfu, & &1) == {second.control_revision, :granted}
  end

  defp grant(adapter, identity, key) do
    assert {:ok, reservation} = Postgres.reserve_publication_grant(identity, key, :microphone)

    assert :confirmed =
             adapter
             |> MediaPlane.with_control_revision(reservation.control_revision)
             |> MediaPlane.grant_publication(
               key,
               identity.episode,
               identity.participant_id,
               :microphone
             )

    assert {:ok, %{status: :confirmed}} =
             Postgres.complete_publication_grant(
               identity.episode,
               reservation.reservation_id,
               :confirmed
             )

    reservation
  end

  # The own SFU's ordering for one source: a control older than the recorded revision is
  # stale, and at a tie a revoke wins. A revoke is applied and then answered ambiguously, as
  # when its response is lost on the way back.
  defp sfu_transport(sfu) do
    fn :post, url, _headers, body, _options ->
      payload = JSON.decode!(body)
      id = url |> URI.parse() |> Map.fetch!(:path) |> Path.basename()
      revision = payload["control_revision"]
      action = if payload["effect"] == "media.grant_publication", do: :granted, else: :revoked

      Agent.update(sfu, fn
        {recorded, _} = state when revision < recorded -> state
        {recorded, :revoked} = state when revision == recorded and action == :granted -> state
        _ -> {revision, action}
      end)

      outcome = if action == :granted, do: "confirmed", else: "ambiguous"

      {:ok, 200, [],
       JSON.encode!(%{"operation_id" => id, "effect" => payload["effect"], "outcome" => outcome})}
    end
  end
end
