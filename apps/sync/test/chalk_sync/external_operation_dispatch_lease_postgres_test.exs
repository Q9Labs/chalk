defmodule ChalkSync.DispatchLeaseTestMediaAdapter do
  @moduledoc false

  def revoke_publication(observer, operation_id, episode, _participant_id, _source) do
    send(observer, {:dispatch_lease_adapter_called, operation_id, episode.episode_id})
    :pending
  end
end

defmodule ChalkSync.ExternalOperationDispatchLeasePostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ExternalOperationDispatchTestHelpers, as: Helpers
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous =
      for key <- [:stateholder, :database_connections],
          do: {key, Application.get_env(:chalk_sync, key)}

    connections = SyncPostgres.start_connections(@database_url, 8)
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      for {key, value} <- previous do
        if value,
          do: Application.put_env(:chalk_sync, key, value),
          else: Application.delete_env(:chalk_sync, key)
      end

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  test "an owner cannot split one Episode while another Episode continues", %{
    connection: connection
  } do
    episode_seed = fixture(connection, 3)
    other_seed = fixture(connection, 2)
    [actor, target, ender] = episode_seed.identities
    [other_actor | _] = other_seed.identities

    mute_id = Helpers.queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    leave_id = Helpers.queue(actor, :participant_leave)
    Helpers.expire_fences(connection, episode_seed)
    end_id = Helpers.queue(ender, :end_episode)
    other_leave_id = Helpers.queue(other_actor, :participant_leave)
    Helpers.expire_fences(connection, other_seed)

    owner_a = UUID.generate()
    owner_b = UUID.generate()
    assert {:ok, [{episode, first}]} = Postgres.claim_operations(1, [], 64, owner_a)
    assert episode == episode_seed.episode
    assert first.external_operation_id == mute_id
    assert %{owner_id: ^owner_a, fence: fence_a} = first.dispatch_lease

    unfenced_candidates =
      Postgrex.query!(
        connection,
        """
        select episode_id, external_operation_id
        from sync_external_operations
        where episode_id = any($1::uuid[])
          and status = 'pending' and next_attempt_at <= now()
        order by acceptance_order
        """,
        [
          [
            UUID.dump!(episode_seed.episode.episode_id),
            UUID.dump!(other_seed.episode.episode_id)
          ]
        ]
      ).rows

    assert unfenced_candidates == [
             [UUID.dump!(episode_seed.episode.episode_id), UUID.dump!(leave_id)],
             [UUID.dump!(episode_seed.episode.episode_id), UUID.dump!(end_id)],
             [UUID.dump!(other_seed.episode.episode_id), UUID.dump!(other_leave_id)]
           ]

    assert {:ok, other_operations} = Postgres.claim_operations(32, [], 64, owner_b)

    assert Enum.map(other_operations, fn {claimed_episode, operation} ->
             {claimed_episode, operation.external_operation_id}
           end) == [{other_seed.episode, other_leave_id}]

    finalize_claimed(other_operations)
    assert_pending_count(connection, other_seed, 0)
    assert :ok = Postgres.release_dispatch_lease(episode, first.dispatch_lease)
    assert is_integer(fence_a)
  end

  test "releasing a lease makes later Episode work immediately claimable", %{
    connection: connection
  } do
    seed = fixture(connection, 3)
    [actor, first_target, second_target] = seed.identities

    first_id =
      Helpers.queue(actor, :mute_participant, %{"participantId" => first_target.participant_id})

    second_id =
      Helpers.queue(actor, :stop_participant_camera, %{
        "participantId" => second_target.participant_id
      })

    owner_a = UUID.generate()
    owner_b = UUID.generate()
    assert {:ok, [{episode, first}]} = Postgres.claim_operations(1, [], 64, owner_a)
    assert first.external_operation_id == first_id
    assert :ok = Postgres.release_dispatch_lease(episode, first.dispatch_lease)

    assert {:ok, [{^episode, second}]} = Postgres.claim_operations(32, [], 64, owner_b)
    assert second.external_operation_id == second_id
    assert second.dispatch_lease.owner_id == owner_b
    assert :ok = Postgres.release_dispatch_lease(episode, second.dispatch_lease)
  end

  test "a provider call within the adapter timeout keeps the Episode lease", %{
    connection: connection
  } do
    seed = fixture(connection, 3)
    [actor, target, _ender] = seed.identities
    mute_id = Helpers.queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    _leave_id = Helpers.queue(actor, :participant_leave)
    Helpers.expire_fences(connection, seed)

    owner_a = UUID.generate()
    owner_b = UUID.generate()
    assert {:ok, [{episode, first}]} = Postgres.claim_operations(1, [], 64, owner_a)
    assert first.external_operation_id == mute_id
    lease = first.dispatch_lease

    adapter_timeout_ms =
      Application.get_env(:chalk_sync, :external_operation_adapter_timeout_ms, 35_000)

    assert [[remaining_ms]] =
             Postgrex.query!(
               connection,
               """
               select (extract(epoch from (expires_at - now())) * 1000)::bigint
               from sync_episode_dispatch_leases
               where tenant_id = $1 and episode_id = $2 and owner_id = $3 and fence = $4
               """,
               [
                 UUID.dump!(episode.tenant_id),
                 UUID.dump!(episode.episode_id),
                 UUID.dump!(owner_a),
                 lease.fence
               ]
             ).rows

    assert remaining_ms > adapter_timeout_ms + 3_000

    Postgrex.query!(
      connection,
      """
      update sync_episode_dispatch_leases
      set expires_at = expires_at - interval '31 seconds'
      where tenant_id = $1 and episode_id = $2 and owner_id = $3 and fence = $4
      """,
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.episode_id),
        UUID.dump!(owner_a),
        lease.fence
      ]
    )

    assert {:ok, []} = Postgres.claim_operations(32, [], 64, owner_b)

    assert {:ok, _decision} =
             Postgres.finalize_operation(episode, mute_id, {:confirmed, :provider}, lease)

    assert_pending_count(connection, seed, 1)
    assert :ok = Postgres.release_dispatch_lease(episode, lease)
  end

  test "overlapping claims by one owner share the live fence", %{connection: connection} do
    seed = fixture(connection, 3)
    [actor, target, _ender] = seed.identities
    mute_id = Helpers.queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    leave_id = Helpers.queue(actor, :participant_leave)
    Helpers.expire_fences(connection, seed)

    owner_id = UUID.generate()
    assert {:ok, [{episode, first}]} = Postgres.claim_operations(1, [], 64, owner_id)
    assert {:ok, [{^episode, second}]} = Postgres.claim_operations(1, [], 64, owner_id)
    assert [first.external_operation_id, second.external_operation_id] == [mute_id, leave_id]
    assert first.dispatch_lease.fence == second.dispatch_lease.fence

    assert {:ok, _decision} =
             Postgres.finalize_operation(
               episode,
               first.external_operation_id,
               {:confirmed, :provider},
               first.dispatch_lease
             )

    assert :ok = Postgres.release_dispatch_lease(episode, second.dispatch_lease)
  end

  test "finishing and releasing the first batch hands later work to the next owner", %{
    connection: connection
  } do
    seed = fixture(connection, 3)
    [actor, target, ender] = seed.identities
    mute_id = Helpers.queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    leave_id = Helpers.queue(actor, :participant_leave)
    Helpers.expire_fences(connection, seed)
    end_id = Helpers.queue(ender, :end_episode)

    owner_a = UUID.generate()
    owner_b = UUID.generate()
    assert {:ok, first_batch} = Postgres.claim_operations(1, [], 64, owner_a)
    assert [{episode, first}] = first_batch
    assert episode == seed.episode
    assert first.external_operation_id == mute_id
    finalize_claimed(first_batch)

    assert {:ok, second_batch} = Postgres.claim_operations(32, [], 64, owner_b)

    assert Enum.map(second_batch, fn {_episode, operation} -> operation.external_operation_id end) ==
             [leave_id, end_id]

    finalize_claimed(second_batch)
    assert_pending_count(connection, seed, 0)
    assert_ended(connection, seed)
  end

  test "the legacy finalizer reproduces the unfenced takeover behavior", %{
    connection: connection
  } do
    seed = fixture(connection, 2)
    [actor, target] = seed.identities

    operation_id =
      Helpers.queue(actor, :mute_participant, %{"participantId" => target.participant_id})

    owner_a = UUID.generate()
    owner_b = UUID.generate()
    assert {:ok, [{episode, first}]} = Postgres.claim_operations(1, [], 64, owner_a)
    old_lease = first.dispatch_lease

    Postgrex.query!(
      connection,
      """
      update sync_episode_dispatch_leases
      set expires_at = now() - interval '1 second'
      where tenant_id = $1 and episode_id = $2
      """,
      [UUID.dump!(seed.episode.tenant_id), UUID.dump!(seed.episode.episode_id)]
    )

    Postgrex.query!(
      connection,
      """
      update sync_external_operations
      set next_attempt_at = now() - interval '1 second'
      where tenant_id = $1 and episode_id = $2 and status = 'pending'
      """,
      [UUID.dump!(seed.episode.tenant_id), UUID.dump!(seed.episode.episode_id)]
    )

    assert {:ok, [{^episode, takeover}]} = Postgres.claim_operations(1, [], 64, owner_b)
    assert takeover.dispatch_lease.fence > old_lease.fence

    assert {:ok, _decision} =
             Postgres.finalize_operation(episode, operation_id, {:confirmed, :provider})

    assert [["applied"]] =
             Postgrex.query!(
               connection,
               "select status from sync_external_operations where external_operation_id = $1",
               [UUID.dump!(operation_id)]
             ).rows

    assert :ok = Postgres.release_dispatch_lease(episode, takeover.dispatch_lease)
  end

  test "takeover fences a paused owner before operation locking", %{connection: connection} do
    seed = fixture(connection, 3)
    [actor, target, ender] = seed.identities
    mute_id = Helpers.queue(actor, :mute_participant, %{"participantId" => target.participant_id})
    leave_id = Helpers.queue(actor, :participant_leave)
    Helpers.expire_fences(connection, seed)
    end_id = Helpers.queue(ender, :end_episode)

    owner_a = UUID.generate()
    owner_b = UUID.generate()
    assert {:ok, first_batch} = Postgres.claim_operations(32, [], 64, owner_a)

    assert Enum.map(first_batch, fn {_episode, operation} -> operation.external_operation_id end) ==
             [mute_id, leave_id, end_id]

    old_lease = hd(first_batch) |> elem(1) |> Map.fetch!(:dispatch_lease)

    Postgrex.query!(
      connection,
      """
      update sync_episode_dispatch_leases
      set expires_at = now() - interval '1 second'
      where tenant_id = $1 and episode_id = $2 and owner_id = $3
      """,
      [
        UUID.dump!(seed.episode.tenant_id),
        UUID.dump!(seed.episode.episode_id),
        UUID.dump!(owner_a)
      ]
    )

    Postgrex.query!(
      connection,
      """
      update sync_external_operations
      set next_attempt_at = now() - interval '1 second'
      where tenant_id = $1 and episode_id = $2 and status = 'pending'
      """,
      [UUID.dump!(seed.episode.tenant_id), UUID.dump!(seed.episode.episode_id)]
    )

    assert {:ok, takeover_batch} = Postgres.claim_operations(32, [], 64, owner_b)

    assert Enum.map(takeover_batch, fn {_episode, operation} ->
             operation.external_operation_id
           end) ==
             [mute_id, leave_id, end_id]

    new_lease = hd(takeover_batch) |> elem(1) |> Map.fetch!(:dispatch_lease)
    assert new_lease.owner_id == owner_b
    assert new_lease.fence > old_lease.fence
    before = operation_snapshot(connection, mute_id)

    assert {:error, :dispatch_lease_lost} =
             Postgres.finalize_operation(
               seed.episode,
               mute_id,
               {:confirmed, :provider},
               old_lease
             )

    assert {:error, :dispatch_lease_lost} = Postgres.renew_dispatch_lease(seed.episode, old_lease)
    assert operation_snapshot(connection, mute_id) == before

    finalize_claimed(takeover_batch)

    assert {:error, :dispatch_lease_lost} =
             Postgres.finalize_operation(
               seed.episode,
               mute_id,
               {:confirmed, :provider},
               old_lease
             )

    assert_ended(connection, seed)
    assert_pending_count(connection, seed, 0)
  end

  test "consumer stops an Episode batch when renewal loses the fence" do
    episode = %EpisodeKey{
      tenant_id: UUID.generate(),
      space_id: UUID.generate(),
      episode_id: UUID.generate()
    }

    dispatch_lease = %{owner_id: UUID.generate(), fence: 17}
    first = consumer_operation(UUID.generate(), dispatch_lease)
    second = consumer_operation(UUID.generate(), dispatch_lease)
    observer = self()
    claim_count = :atomics.new(1, [])

    claim = fn _limit, _excluded, _episode_limit, owner_id ->
      if :atomics.add_get(claim_count, 1, 1) == 1 do
        send(observer, {:dispatch_lease_consumer_owner, owner_id})
        {:ok, [{episode, first}, {episode, second}]}
      else
        {:ok, []}
      end
    end

    renew = fn renewed_episode, renewed_lease ->
      send(observer, {:dispatch_lease_renewal, self(), renewed_episode, renewed_lease})

      receive do
        :renew -> :ok
        :lost -> {:error, :dispatch_lease_lost}
      end
    end

    release = fn released_episode, released_lease ->
      send(observer, {:dispatch_lease_released, released_episode, released_lease})
      :ok
    end

    start_supervised!(
      {ExternalOperationConsumer,
       [
         name: :dispatch_lease_consumer_test,
         poll_interval_ms: 1,
         page_size: 8,
         claim_operations: claim,
         renew_dispatch_lease: renew,
         release_dispatch_lease: release,
         media_plane: {ChalkSync.DispatchLeaseTestMediaAdapter, observer}
       ]}
    )

    assert_receive {:dispatch_lease_consumer_owner, owner_id}, 2_000
    assert {:ok, _owner_bytes} = UUID.dump(owner_id)
    assert_receive {:dispatch_lease_renewal, worker, ^episode, ^dispatch_lease}, 2_000
    send(worker, :renew)
    assert_receive {:dispatch_lease_adapter_called, first_id, _episode_id}, 2_000
    assert first_id == first.external_operation_id
    assert_receive {:dispatch_lease_renewal, ^worker, ^episode, ^dispatch_lease}, 2_000
    second_id = second.external_operation_id
    send(worker, :lost)
    assert_receive {:dispatch_lease_released, ^episode, ^dispatch_lease}, 2_000
    refute_receive {:dispatch_lease_adapter_called, ^second_id, _episode_id}, 50
    refute_receive {:dispatch_lease_released, ^episode, ^dispatch_lease}, 50
    stop_supervised!(ExternalOperationConsumer)
  end

  defp fixture(connection, count) do
    seed = Helpers.fixture(connection, count)
    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    seed
  end

  defp finalize_claimed(operations) do
    for {episode, operation} <- operations do
      assert {:ok, _decision} =
               Postgres.finalize_operation(
                 episode,
                 operation.external_operation_id,
                 {:confirmed, :provider},
                 operation.dispatch_lease
               )
    end

    case operations do
      [{episode, operation} | _] ->
        Postgres.release_dispatch_lease(episode, operation.dispatch_lease)

      [] ->
        :ok
    end
  end

  defp operation_snapshot(connection, operation_id) do
    Postgrex.query!(
      connection,
      """
      select status, attempt_count, next_attempt_at, last_error_code,
        applied_event_id, applied_revision, completed_at
      from sync_external_operations
      where external_operation_id = $1
      """,
      [UUID.dump!(operation_id)]
    ).rows
  end

  defp assert_pending_count(connection, seed, count),
    do: Helpers.assert_pending_count(connection, seed, count)

  defp assert_ended(connection, seed), do: Helpers.assert_ended(connection, seed)

  defp consumer_operation(operation_id, dispatch_lease) do
    %ExternalOperation{
      external_operation_id: operation_id,
      request_key: operation_id,
      request_fingerprint: operation_id,
      name: :mute_participant,
      payload: %{},
      status: :pending,
      attempt_count: 1,
      target_participant_id: UUID.generate(),
      dispatch_lease: dispatch_lease
    }
  end
end
