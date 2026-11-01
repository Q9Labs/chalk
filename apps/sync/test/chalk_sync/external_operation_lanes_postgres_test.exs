defmodule ChalkSync.ExternalOperationLanesPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess

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
