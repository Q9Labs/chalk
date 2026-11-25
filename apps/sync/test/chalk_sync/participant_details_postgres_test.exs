defmodule ChalkSync.ParticipantDetailsPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  setup do
    previous = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url)
    Enum.each(connections, &Process.unlink/1)
    connection = hd(connections)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    fixture = SyncPostgres.seed_pending_join(connection)

    on_exit(fn ->
      SyncPostgres.cleanup(connection, fixture.episode)
      SyncPostgres.restore_env(:database_connections, previous)
      Enum.each(connections, &TestProcess.stop/1)
    end)

    %{connection: connection, fixture: fixture}
  end

  test "agent kind stays out of durable control and is overlaid from product rows", %{
    connection: connection,
    fixture: fixture
  } do
    identity_id = UUID.generate()

    Postgrex.query!(
      connection,
      """
      insert into identities (id, tenant_id, kind, external_id, display_name)
      values ($1, $2, 'agent', 'participant-details-agent', 'Agent Participant')
      """,
      [UUID.dump!(identity_id), UUID.dump!(fixture.episode.tenant_id)]
    )

    Postgrex.query!(
      connection,
      "update participants set identity_id=$2 where tenant_id=$1 and id=$3",
      [
        UUID.dump!(fixture.episode.tenant_id),
        UUID.dump!(identity_id),
        UUID.dump!(fixture.identity.participant_id)
      ]
    )

    assert {:ok, decision} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert decision.event.payload["identity_kind"] == "agent"

    [[stored_payload, folded_state]] =
      Postgrex.query!(
        connection,
        """
        select events.payload, control.folded_state
        from sync_control_events events
        join sync_episode_control control
          on control.tenant_id=events.tenant_id
          and control.space_id=events.space_id
          and control.episode_id=events.episode_id
        where events.tenant_id=$1 and events.space_id=$2 and events.episode_id=$3
          and events.event_name='participant_joined'
        """,
        [
          UUID.dump!(fixture.episode.tenant_id),
          UUID.dump!(fixture.episode.space_id),
          UUID.dump!(fixture.episode.episode_id)
        ]
      ).rows

    assert stored_payload |> Map.keys() |> Enum.sort() == [
             "admission_revision",
             "display_name",
             "participant_id",
             "role"
           ]

    [stored_participant] = folded_state["participants"]

    assert stored_participant |> Map.keys() |> Enum.sort() == [
             "admission_revision",
             "capabilities",
             "display_name",
             "hand_raised",
             "participant_id",
             "role"
           ]

    refute Map.has_key?(stored_payload, "identity_kind")
    refute Map.has_key?(stored_participant, "identity_kind")

    assert {:ok, recovery} = Postgres.recover_episode(fixture.episode, nil)
    [wire_participant] = recovery.snapshot["participants"]
    assert wire_participant["identity_kind"] == "agent"

    assert {:ok, [replayed]} = Postgres.recovery_page(fixture.episode, 0, decision.revision)
    assert replayed.payload["identity_kind"] == "agent"
  end
end
