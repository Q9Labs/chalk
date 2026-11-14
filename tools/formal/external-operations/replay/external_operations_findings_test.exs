defmodule ChalkSync.ExternalOperationsFindingsTest do
  @moduledoc """
  Replays of the three findings in tools/formal/external-operations against the real
  Sync code and Postgres. Each test passes while its finding is still present. When a
  fix lands, the last assertion fails with a message that says what changed.

  Run it with tools/formal/external-operations/replay/run.sh, which copies this file
  into apps/sync/test, runs it against Postgres, and removes the copy.
  """
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

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

  # F-A. A participant who is publishing asks for a second grant. While that request is
  # open, assign_roles removes publishAudio and starts a source-stop child. The SFU then
  # refuses the second grant. complete_publication_grant sees a failed grant that needs
  # cleanup and settles the pending child as applied, without any call to the SFU. The
  # first grant is still live.
  test "F-A: a refused second grant settles the source stop without revoking the first", %{
    connection: connection,
    fixture: fixture
  } do
    episode = fixture.episode
    [host, speaker] = fixture.identities
    {:ok, sfu} = Agent.start_link(fn -> nil end)
    adapter = adapter(sfu, apply_revoke?: true)

    assert {:ok, first} = Postgres.reserve_publication_grant(speaker, "ff_refused_mic_0001", :microphone)

    assert :confirmed =
             adapter
             |> MediaPlane.with_control_revision(first.control_revision)
             |> MediaPlane.grant_publication(
               "ff_refused_mic_0001",
               episode,
               speaker.participant_id,
               :microphone
             )

    assert {:ok, %{status: :confirmed}} =
             Postgres.complete_publication_grant(episode, first.reservation_id, :confirmed)

    assert {:ok, second} = Postgres.reserve_publication_grant(speaker, "ff_refused_mic_0002", :microphone)
    publication = %{participant_id: speaker.participant_id, source: :microphone, enabled: true}
    assert {:ok, %{result: :pending}} = assign_observer(host, speaker, [publication])
    assert [child_id] = stop_operation_ids(connection, episode)

    assert {:ok, %{status: :failed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               episode,
               second.reservation_id,
               {:terminal_failure, :provider_refused}
             )

    assert {:ok, %{status: :applied}} = Postgres.read_operation(episode, child_id),
           "F-A is fixed: the source stop is no longer settled by a failed grant"

    assert {revision, :granted} = Agent.get(sfu, & &1)
    assert revision == first.control_revision,
           "F-A is fixed: the first grant is no longer live"
  end

  # F-C. The Live Episode process reserves a grant and dies before it calls the SFU. The
  # reservation expires. The restarted process asks again with the same operation id and
  # gets the expired row back, so it still calls the SFU. assign_roles runs in between: it
  # sees an expired reservation and no live publication, so it commits the role change with
  # no cleanup operation. The late grant then lands for a participant without publishAudio,
  # and complete_publication_grant only reports :cleanup_required.
  test "F-C: an expired reservation that is resent grants a source nobody will revoke", %{
    connection: connection,
    fixture: fixture
  } do
    [host, speaker] = fixture.identities
    {:ok, sfu} = Agent.start_link(fn -> nil end)
    adapter = adapter(sfu, apply_revoke?: true)
    grant_id = "ff_resend_mic_0001"

    assert {:ok, first} = Postgres.reserve_publication_grant(speaker, grant_id, :microphone)

    Postgrex.query!(
      connection,
      "update sync_publication_grant_reservations set created_at = now() - interval '1 minute', expires_at = now() - interval '1 second' where reservation_id = $1",
      [UUID.dump!(first.reservation_id)]
    )

    assert {:ok, again} = Postgres.reserve_publication_grant(speaker, grant_id, :microphone)
    assert again.reservation_id == first.reservation_id

    assert {:ok, %{result: :committed}} = assign_observer(host, speaker, [])
    assert stop_operation_ids(connection, fixture.episode) == []

    assert :confirmed =
             adapter
             |> MediaPlane.with_control_revision(again.control_revision)
             |> MediaPlane.grant_publication(
               grant_id,
               speaker.episode,
               speaker.participant_id,
               :microphone
             )

    assert {:ok, %{result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               speaker.episode,
               again.reservation_id,
               :confirmed
             )

    assert pending_operation_count(connection, fixture.episode) == 0,
           "F-C is fixed: an operation now exists to take the source away"

    assert {_revision, :granted} = Agent.get(sfu, & &1),
           "F-C is fixed: the SFU no longer holds a live source"
  end

  # F-B. A role change removes publishAudio from a participant who is publishing. The
  # source-stop child cannot get a clear answer from the SFU for 100 attempts, so Sync
  # fails it with retry_exhausted. The role change stays committed, the child is failed,
  # and the SFU still holds the source as granted. No operation is left to revoke it.
  test "F-B: a source stop that exhausts its retries leaves the source live", %{
    connection: connection,
    fixture: fixture
  } do
    episode = fixture.episode
    [host, speaker] = fixture.identities
    {:ok, sfu} = Agent.start_link(fn -> nil end)
    adapter = adapter(sfu, apply_revoke?: false)
    grant_id = "ff_exhaust_mic_0001"

    assert {:ok, grant} = Postgres.reserve_publication_grant(speaker, grant_id, :microphone)

    assert :confirmed =
             adapter
             |> MediaPlane.with_control_revision(grant.control_revision)
             |> MediaPlane.grant_publication(grant_id, episode, speaker.participant_id, :microphone)

    assert {:ok, %{status: :confirmed, result: :authorized}} =
             Postgres.complete_publication_grant(episode, grant.reservation_id, :confirmed)

    publication = %{participant_id: speaker.participant_id, source: :microphone, enabled: true}
    assert {:ok, %{result: :pending}} = assign_observer(host, speaker, [publication])
    assert [child_id] = stop_operation_ids(connection, episode)

    Postgrex.query!(
      connection,
      "update sync_external_operations set attempt_count=99, next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(child_id)]
    )

    assert {:ok, operations} = Postgres.claim_operations(64)

    assert {^episode, stop} =
             Enum.find(operations, fn {_, op} -> op.external_operation_id == child_id end)

    assert :terminal_failure =
             ExternalOperationConsumer.execute_operation(
               episode,
               stop,
               {MediaPlane, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :failed}} = Postgres.read_operation(episode, child_id)
    assert {_revision, :granted} = Agent.get(sfu, & &1)

    assert pending_operation_count(connection, episode) == 0,
           "F-B is fixed: an operation is still pending to take the source away"
  end

  defp assign_observer(host, speaker, publications) do
    {:ok, command} =
      Command.new(UUID.generate(), :assign_roles, %{
        "participantId" => speaker.participant_id,
        "role" => "observer"
      })

    Postgres.begin_role_transition(host, command, publications)
  end

  defp stop_operation_ids(connection, episode) do
    %{rows: rows} =
      Postgrex.query!(
        connection,
        "select external_operation_id from sync_external_operations where episode_id=$1 and operation_name='role_transition_source_stop'",
        [UUID.dump!(episode.episode_id)]
      )

    Enum.map(rows, fn [id] -> UUID.load!(id) end)
  end

  defp pending_operation_count(connection, episode) do
    %{rows: [[count]]} =
      Postgrex.query!(
        connection,
        "select count(*) from sync_external_operations where episode_id=$1 and status='pending' and operation_name <> 'role_transition_cleanup'",
        [UUID.dump!(episode.episode_id)]
      )

    count
  end

  defp adapter(sfu, options) do
    Client.new!(base_url: "http://localhost:4000", transport: sfu_transport(sfu, options))
    |> MediaPlane.new!()
  end

  # The own SFU's ordering for one source: a control older than the recorded revision is
  # stale, and at a tie a revoke wins. With apply_revoke?: false a revoke never reaches the
  # SFU and the caller sees an ambiguous outcome, as when the SFU is unreachable.
  defp sfu_transport(sfu, apply_revoke?: apply_revoke?) do
    fn :post, url, _headers, body, _options ->
      payload = JSON.decode!(body)
      id = url |> URI.parse() |> Map.fetch!(:path) |> Path.basename()
      revision = payload["control_revision"]
      action = if payload["effect"] == "media.grant_publication", do: :granted, else: :revoked

      if action == :granted or apply_revoke? do
        Agent.update(sfu, fn
          {recorded, _} = state when revision < recorded -> state
          {recorded, :revoked} = state when revision == recorded and action == :granted -> state
          _ -> {revision, action}
        end)
      end

      outcome = if action == :granted, do: "confirmed", else: "ambiguous"

      {:ok, 200, [],
       JSON.encode!(%{"operation_id" => id, "effect" => payload["effect"], "outcome" => outcome})}
    end
  end
end
