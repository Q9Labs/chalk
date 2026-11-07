defmodule ChalkSync.ExternalOperationLanesPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  @admission_budget_ms 500

  # Stands in for Cloudflare answering CloseTracks on a long-dead session.
  defmodule SlowProvider do
    def remove_participant(owner, operation_id, _episode, _participant_id) do
      send(owner, {:cleanup_started, operation_id, self()})

      receive do
        :release -> :satisfied
      after
        5_000 -> :satisfied
      end
    end
  end

  setup_all do
    previous = Application.get_env(:chalk_sync, :database_connections)
    stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
    connections = SyncPostgres.start_connections(@database_url, 4)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    Application.put_env(:chalk_sync, :stateholder, Postgres)

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, stateholder)

      if previous,
        do: Application.put_env(:chalk_sync, :database_connections, previous),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  test "an admission finalizes while another Episode's slow cleanup is in flight", %{
    connection: connection
  } do
    queue_slow_cleanups(connection, 1)
    start_consumers()
    assert_receive {:cleanup_started, _id, _provider}, 5_000

    assert admission_latency_ms(connection) < @admission_budget_ms
    release_cleanups()
  end

  test "an admission finalizes behind four slow cleanups and they run side by side", %{
    connection: connection
  } do
    queue_slow_cleanups(connection, 4)
    start_consumers()
    assert_receive {:cleanup_started, _id, _provider}, 5_000

    assert admission_latency_ms(connection) < @admission_budget_ms

    for _other <- 1..3, do: assert_receive({:cleanup_started, _id, _provider}, 1_000)
    release_cleanups()
  end

  @local_names ~w(admit_participant deny_admission admission_request_expired)
  @provider_names ~w(mute_participant stop_participant_camera stop_participant_screen_share)

  test "the provider claim leaves local operations alone", %{connection: connection} do
    set = seed_operation_set(connection)
    claimed = claim_names(&Postgres.claim_provider_operations/1, set.episode)
    assert Enum.sort(claimed) == Enum.sort(@provider_names)
  end

  test "the local claim leaves provider operations alone", %{connection: connection} do
    set = seed_operation_set(connection)
    claimed = claim_names(&Postgres.claim_local_operations/1, set.episode)
    assert Enum.sort(claimed) == Enum.sort(@local_names)
  end

  test "local and provider claims split every operation but role cleanup", %{
    connection: connection
  } do
    set = seed_operation_set(connection)
    local = claim_names(&Postgres.claim_local_operations/1, set.episode)
    provider = claim_names(&Postgres.claim_provider_operations/1, set.episode)

    assert local -- @local_names == []
    assert provider -- @provider_names == []
    assert Enum.sort(local ++ provider) == Enum.sort(@local_names ++ @provider_names)
    refute "role_transition_cleanup" in (local ++ provider)
  end

  defp claim_names(claim, episode) do
    {:ok, operations} = claim.(64)

    for {^episode, operation} <- operations, do: Atom.to_string(operation.name)
  end

  # Claims lease an operation for a minute, so each test needs its own set.
  defp seed_operation_set(connection) do
    fixture = seed(connection)
    names = @local_names ++ @provider_names ++ ["role_transition_cleanup"]
    Enum.each(names, &insert_pending_operation(connection, fixture.episode, &1))
    fixture
  end

  defp insert_pending_operation(connection, episode, name) do
    request_key = unique_key("external_lane_claim")

    Postgrex.query!(
      connection,
      """
      insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, payload, fence_active
      ) values ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, false)
      """,
      [
        UUID.dump!(episode.tenant_id),
        UUID.dump!(episode.space_id),
        UUID.dump!(episode.episode_id),
        UUID.dump!(UUID.generate()),
        request_key,
        :crypto.hash(:sha256, request_key),
        name
      ]
    )
  end

  defp start_consumers do
    ExternalOperationConsumer.child_specs(
      poll_interval_ms: 10,
      page_size: 8,
      max_backoff_ms: 100,
      adapter_timeout_ms: 30_000,
      media_plane: {SlowProvider, self()}
    )
    |> Enum.each(&start_supervised!/1)
  end

  defp queue_slow_cleanups(connection, count) do
    for _episode <- 1..count do
      fixture = seed(connection)
      leaver = List.last(fixture.identities)
      {:ok, leave} = Operation.new(unique_key("external_lane_leave"), :participant_leave, %{})
      assert {:ok, %{result: :applied}} = Postgres.begin_operation(leaver, leave)
    end
  end

  defp admission_latency_ms(connection) do
    fixture = connection |> seed() |> then(&SyncPostgres.seed_admission_request(connection, &1))

    {:ok, admission} =
      Operation.new(unique_key("external_lane_admit"), :admit_participant, %{
        "admissionRequestId" => fixture.admission_request_id
      })

    assert {:ok, %{external_operation_id: id}} =
             Postgres.begin_operation(hd(fixture.identities), admission)

    started = System.monotonic_time(:millisecond)
    await_applied(fixture.episode, id, started)
  end

  defp await_applied(episode, id, started) do
    elapsed = System.monotonic_time(:millisecond) - started

    case Postgres.read_operation(episode, id) do
      {:ok, %{status: :applied}} ->
        elapsed

      _pending when elapsed > 3_000 ->
        flunk("admission was not finalized after #{elapsed} ms")

      _pending ->
        Process.sleep(10)
        await_applied(episode, id, started)
    end
  end

  # Releasing lets the consumer finalize the cleanups before the fixtures are deleted.
  defp release_cleanups do
    receive do
      {:cleanup_started, _id, provider} ->
        send(provider, :release)
        release_cleanups()
    after
      0 -> Process.sleep(200)
    end
  end

  defp seed(connection) do
    fixture = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    fixture
  end

  defp unique_key(prefix),
    do: prefix <> "_" <> Integer.to_string(System.unique_integer([:positive]))
end
