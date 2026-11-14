defmodule ChalkSync.ExternalOperationsFindingsTest do
  @moduledoc """
  Regression tests for the three bugs that tools/formal/external-operations found in the
  external-operation queue, run against the real Sync code and Postgres.
  """
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer.Execution
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

  # A participant who is publishing asks for a second grant. While that request is open,
  # assign_roles removes publishAudio and starts a source-stop child. The SFU refuses the
  # second grant. The child must stay pending and revoke the first grant at the SFU.
  test "a refused second grant leaves the source stop to revoke the first grant", %{
    connection: connection,
    fixture: fixture
  } do
    episode = fixture.episode
    [host, speaker] = fixture.identities
    {:ok, sfu} = Agent.start_link(fn -> nil end)
    adapter = adapter(sfu, apply_revoke?: true)

    assert {:ok, first} =
             Postgres.reserve_publication_grant(speaker, "ff_refused_mic_0001", :microphone)

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

    assert {:ok, second} =
             Postgres.reserve_publication_grant(speaker, "ff_refused_mic_0002", :microphone)

    publication = %{participant_id: speaker.participant_id, source: :microphone, enabled: true}
    assert {:ok, %{result: :pending}} = assign_observer(host, speaker, [publication])
    assert [child_id] = stop_operation_ids(connection, episode)

    assert {:ok, %{status: :failed, result: :cleanup_required}} =
             Postgres.complete_publication_grant(
               episode,
               second.reservation_id,
               {:terminal_failure, :provider_refused}
             )

    assert {:ok, %{status: :pending}} = Postgres.read_operation(episode, child_id)
    assert {_revision, :granted} = Agent.get(sfu, & &1)

    assert :confirmed = run_stop(episode, child_id, adapter)
    assert {:ok, %{status: :applied}} = Postgres.read_operation(episode, child_id)
    assert {_revision, :revoked} = Agent.get(sfu, & &1)
  end

  # The Live Episode process reserves a grant and dies before it calls the SFU. The
  # reservation expires. The restarted process asks again with the same operation id. It
  # must get a new reservation, so a role change in between starts a cleanup.
  test "an expired reservation that is resent is replaced and covered by the role change", %{
    connection: connection,
    fixture: fixture
  } do
    [host, speaker] = fixture.identities
    episode = fixture.episode
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
    refute again.reservation_id == first.reservation_id
    assert again.control_revision > first.control_revision

    assert {:ok, %{result: :pending}} = assign_observer(host, speaker, [])
    assert [child_id] = stop_operation_ids(connection, episode)

    assert :confirmed =
             adapter
             |> MediaPlane.with_control_revision(again.control_revision)
             |> MediaPlane.grant_publication(
               grant_id,
               episode,
               speaker.participant_id,
               :microphone
             )

    assert {:ok, %{result: :cleanup_required}} =
             Postgres.complete_publication_grant(episode, again.reservation_id, :confirmed)

    assert :confirmed = run_stop(episode, child_id, adapter)
    assert {_revision, :revoked} = Agent.get(sfu, & &1)
  end

  # A role change removes publishAudio from a participant who is publishing. The SFU gives
  # no clear answer to the source stop for 100 attempts. The stop must stay pending and
  # revoke the source once the SFU answers.
  test "a source stop that exhausts its attempts stays pending until the SFU revokes", %{
    connection: connection,
    fixture: fixture
  } do
    episode = fixture.episode
    [host, speaker] = fixture.identities
    {:ok, sfu} = Agent.start_link(fn -> nil end)
    silent = adapter(sfu, apply_revoke?: false)
    grant_id = "ff_exhaust_mic_0001"

    assert {:ok, grant} = Postgres.reserve_publication_grant(speaker, grant_id, :microphone)

    assert :confirmed =
             silent
             |> MediaPlane.with_control_revision(grant.control_revision)
             |> MediaPlane.grant_publication(
               grant_id,
               episode,
               speaker.participant_id,
               :microphone
             )

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

    assert :pending = run_stop(episode, child_id, silent)
    assert {:ok, %{status: :pending}} = Postgres.read_operation(episode, child_id)
    assert {_revision, :granted} = Agent.get(sfu, & &1)

    Postgrex.query!(
      connection,
      "update sync_external_operations set next_attempt_at=now() where external_operation_id=$1",
      [UUID.dump!(child_id)]
    )

    assert :confirmed = run_stop(episode, child_id, adapter(sfu, apply_revoke?: true))
    assert {:ok, %{status: :applied}} = Postgres.read_operation(episode, child_id)
    assert {_revision, :revoked} = Agent.get(sfu, & &1)
  end

  defp run_stop(episode, child_id, adapter) do
    assert {:ok, operations} = Postgres.claim_operations(64)

    assert {^episode, stop} =
             Enum.find(operations, fn {_, op} -> op.external_operation_id == child_id end)

    Execution.execute_operation(
      episode,
      stop,
      {MediaPlane, adapter},
      nil,
      &Postgres.finalize_operation/3
    )
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

      if action == :granted or apply_revoke?, do: record_control(sfu, revision, action)

      outcome = if action == :granted or apply_revoke?, do: "confirmed", else: "ambiguous"

      {:ok, 200, [],
       JSON.encode!(%{"operation_id" => id, "effect" => payload["effect"], "outcome" => outcome})}
    end
  end

  defp record_control(sfu, revision, action) do
    Agent.update(sfu, fn
      {recorded, _} = state when revision < recorded -> state
      {recorded, :revoked} = state when revision == recorded and action == :granted -> state
      _ -> {revision, action}
    end)
  end
end
