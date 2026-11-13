defmodule ChalkSync.LifecycleConsumerEntryGenerationPostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.LifecycleConsumerCase

  alias ChalkSync.ExternalOperationConsumer.Execution
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @tag :entry_ownership
  test "a newer confirmed entry voids an accepted older Leave through finalization", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    first = entry_identity(fixture.identity, 1, "before-reentry")
    current = entry_identity(fixture.identity, 2, "after-reentry")
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, _} = Postgres.recover(current, nil)
    {:ok, leave} = Operation.new("inflight_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(first, leave)

    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)

    assert {:ok, %{result: :failed}} =
             Postgres.finalize_operation(fixture.episode, id, {:confirmed, :provider})

    assert [["active", "joined"]] = entry_rows(connection, current)

    assert [[0]] =
             Postgrex.query!(
               connection,
               "select count(*) from sync_publication_fences where participant_id=$1",
               [UUID.dump!(current.participant_id)]
             ).rows

    assert [["rejected"]] =
             Postgrex.query!(
               connection,
               "select outcome from sync_command_receipts where external_operation_id=$1",
               [UUID.dump!(id)]
             ).rows

    leave_entry(connection, current, "newer_entry_leave_001")
  end

  @tag :entry_ownership
  test "an older confirmation retry cannot reclaim Leave or cancel the newer entry's Leave", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    first = entry_identity(fixture.identity, 1, "older-entry")
    current = entry_identity(fixture.identity, 2, "newer-entry")
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(first)
    {:ok, stale} = Operation.new("retried_older_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.begin_operation(first, stale)

    {:ok, own} = Operation.new("newer_own_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :applied, external_operation_id: id}} =
             Postgres.begin_operation(current, own)

    assert {:error, :invalid_admission_intent} = Postgres.confirm_admission(first)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(fixture.episode, id, {:confirmed, :provider})

    assert [["left", "left"]] = entry_rows(connection, current)
  end

  @tag :entry_ownership
  test "a refreshed reconnect Leaves the same entry without another entered", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    original = entry_identity(fixture.identity, 1, "before-refresh")
    refreshed = entry_identity(fixture.identity, 1, "after-refresh")
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(original)
    assert {:ok, _} = Postgres.recover(refreshed, nil)
    leave_entry(connection, refreshed, "refreshed_entry_leave_001")
  end

  @tag :entry_generation
  test "entry admission allocates monotonically and resumption cannot choose a future generation",
       %{connections: connections} do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, first} = Postgres.admit_entry(fixture.identity, :new)
    assert {:ok, current} = Postgres.admit_entry(fixture.identity, :new)
    assert current.entry_generation == first.entry_generation + 1
    assert {:ok, resumed} = Postgres.admit_entry(fixture.identity, first.entry_generation)
    assert resumed.entry_generation == first.entry_generation

    assert {:error, :invalid_admission_intent} =
             Postgres.admit_entry(fixture.identity, current.entry_generation + 1)

    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(resumed)
    leave_entry(connection, current, "allocated_entry_leave_001")
    assert {:error, :invalid_admission_intent} = Postgres.confirm_admission(current)
  end

  @tag :entry_generation
  test "a claimed older Leave never reaches the provider across an admitted newer entry", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, first} = Postgres.admit_entry(fixture.identity, :new)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, current} = Postgres.admit_entry(fixture.identity, :new)
    {:ok, leave} = Operation.new("provider_entry_leave_001", :participant_leave, %{})
    assert {:ok, %{external_operation_id: id}} = Postgres.begin_operation(first, leave)
    assert {:ok, operations} = Postgres.claim_operations(64)

    {_, claimed} =
      Enum.find(operations, fn {_, operation} -> operation.external_operation_id == id end)

    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    media = {MediaPlaneTestAdapter, adapter}
    finalize = &Postgres.finalize_operation/3

    assert :pending =
             Execution.execute_operation(
               fixture.episode,
               claimed,
               media,
               nil,
               finalize
             )

    assert [] == MediaPlaneTestAdapter.calls(adapter)
    assert {:ok, %{result: :already_applied}} = Postgres.confirm_admission(current)

    assert :terminal_failure =
             Execution.execute_operation(
               fixture.episode,
               claimed,
               media,
               nil,
               finalize
             )

    assert [] == MediaPlaneTestAdapter.calls(adapter)
    assert [["active", "joined"]] = entry_rows(connection, current)
    leave_entry(connection, current, "provider_current_leave_001")
  end

  @tag :entry_generation
  test "an abandoned newer admission defers Leave until its deterministic expiry", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    assert {:ok, first} = Postgres.admit_entry(fixture.identity, :new)
    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(first)
    assert {:ok, abandoned} = Postgres.admit_entry(fixture.identity, :new)
    {:ok, leave} = Operation.new("abandoned_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :pending, external_operation_id: id}} =
             Postgres.begin_operation(first, leave)

    assert :pending = Postgres.prepare_entry_leave(fixture.episode, id)

    Postgrex.query!(
      connection,
      "update participant_join_seats set issued_entry_expires_at=now()-interval '1 second' where participant_id=$1",
      [UUID.dump!(first.participant_id)]
    )

    assert {:error, :entry_expired} = Postgres.confirm_admission(abandoned)
    assert :ready = Postgres.prepare_entry_leave(fixture.episode, id)
    assert {:ok, operations} = Postgres.claim_operations(64)

    {_, claimed} =
      Enum.find(operations, fn {_, operation} -> operation.external_operation_id == id end)

    assert :confirmed =
             Execution.execute_operation(
               fixture.episode,
               claimed,
               nil,
               nil,
               &Postgres.finalize_operation/3
             )

    assert [["left", "left"]] = entry_rows(connection, first)
  end

  @tag :entry_generation
  test "legacy hello allocates ownership without extending the legacy welcome", %{
    connections: connections,
    port: port
  } do
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    for expected <- [3, 4] do
      {:ok, client} = Client.connect(port, "/v1/sync")
      on_exit(fn -> Client.close_tcp(client) end)
      client = Client.send_json(client, hello(fixture.identity))
      assert {:json, %{"type" => "welcome"} = welcome, _client} = Client.recv(client)
      refute Map.has_key?(welcome, "entry_generation")

      assert [[^expected]] =
               Postgrex.query!(
                 connection,
                 "select confirmed_entry_generation from participant_join_seats where participant_id=$1",
                 [UUID.dump!(fixture.identity.participant_id)]
               ).rows
    end

    old = %{fixture.identity | entry_generation: 3}
    current = %{fixture.identity | entry_generation: 4}
    {:ok, leave} = Operation.new("legacy_old_entry_leave_001", :participant_leave, %{})

    assert {:ok, %{result: :rejected, reason: :participant_inactive}} =
             Postgres.begin_operation(old, leave)

    leave_entry(connection, current, "legacy_current_entry_leave_001")
  end

  defp entry_rows(connection, identity) do
    Postgrex.query!(
      connection,
      "select p.status,s.state from participants p join participant_join_seats s on s.participant_id=p.id where p.id=$1",
      [UUID.dump!(identity.participant_id)]
    ).rows
  end

  defp leave_entry(connection, identity, key) do
    {:ok, leave} = Operation.new(key, :participant_leave, %{})

    assert {:ok, %{external_operation_id: id}} =
             Postgres.begin_operation(identity, leave)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(identity.episode, id, {:confirmed, :provider})

    assert [["left", "left"]] = entry_rows(connection, identity)
  end
end
