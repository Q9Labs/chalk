defmodule ChalkSync.Stateholder.PostgresAttendanceTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.ObservedContext
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")
  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous,
          do: Application.put_env(:chalk_sync, :database_connections, previous),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, fn pid -> if Process.alive?(pid), do: GenServer.stop(pid) end)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  for name <- [:end_episode, :tenant_end_episode, :maximum_duration_expired] do
    test "#{name} closes every admitted Participant once before the Episode Event", %{
      connection: connection
    } do
      fixture = fixture(connection, 13)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      name = unquote(name)
      payload = end_payload(name)

      prepare_deadline(connection, fixture, name)

      {:ok, operation} = Operation.new("attendance_end_0001", name, payload)

      {:ok, context} =
        ObservedContext.new(UUID.generate(), UUID.generate(), nil, nil, DateTime.utc_now())

      operation = Operation.observe(operation, context)

      begin = begin_end(fixture, name, operation)
      assert {:ok, %{external_operation_id: id}} = begin

      {elapsed, result} =
        :timer.tc(fn ->
          Postgres.finalize_operation(fixture.episode, id, {:confirmed, :provider})
        end)

      assert {:ok, %{result: :applied}} = result

      IO.puts(
        "ATTENDANCE end #{name}: #{elapsed / 1000} ms; deliveries=#{length(events(connection, fixture))}"
      )

      assert_departures(connection, fixture, 13)
      assert {:ok, _} = Postgres.finalize_operation(fixture.episode, id, {:confirmed, :provider})
      assert length(events(connection, fixture)) == 14
    end
  end

  test "leave racing Episode end emits exactly one departure for each Participant", %{
    connection: connection
  } do
    for winner <- [:leave, :end] do
      fixture = fixture(connection, 2)
      on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
      {:ok, leave} = Operation.new("attendance_leave_001", :participant_leave, %{})

      if winner == :leave do
        assert {:ok, %{external_operation_id: leave_id}} =
                 Postgres.begin_operation(List.last(fixture.identities), leave)

        assert {:ok, _} =
                 Postgres.finalize_operation(fixture.episode, leave_id, {:confirmed, :provider})

        assert {:ok, _} =
                 Postgres.finalize_operation(fixture.episode, leave_id, {:confirmed, :provider})
      end

      {:ok, ending} = Operation.new("attendance_end_0002", :end_episode, %{})

      assert {:ok, %{external_operation_id: end_id}} =
               Postgres.begin_operation(hd(fixture.identities), ending)

      if winner == :end do
        assert {:ok, %{result: :rejected, reason: :episode_ended}} =
                 Postgres.begin_operation(List.last(fixture.identities), leave)
      end

      assert {:ok, _} =
               Postgres.finalize_operation(fixture.episode, end_id, {:confirmed, :provider})

      rows = events(connection, fixture)
      left = Enum.filter(rows, &(&1["event"] == "participant.left"))
      assert length(left) == 2
      assert left |> Enum.map(& &1["data"]["object"]["id"]) |> Enum.uniq() |> length() == 2
    end
  end

  test "Episode end supersedes an accepted leave intent without losing its departure", %{
    connection: connection
  } do
    fixture = fixture(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)
    participant = List.last(fixture.identities)
    intent_id = UUID.generate()

    scope = [
      UUID.dump!(fixture.episode.tenant_id),
      UUID.dump!(fixture.episode.space_id),
      UUID.dump!(fixture.episode.episode_id)
    ]

    Postgrex.query!(connection, "update participants set status='leaving' where id=$1", [
      UUID.dump!(participant.participant_id)
    ])

    Postgrex.query!(
      connection,
      """
        insert into sync_lifecycle_intents (tenant_id, space_id, episode_id, lifecycle_intent_id, request_key, request_fingerprint, intent_name, participant_id, participant_generation, payload, status)
        values ($1,$2,$3,$4,'attendance_pending_leave', $5,'participant_left',$6,1,$7,'pending')
      """,
      scope ++
        [
          UUID.dump!(intent_id),
          :crypto.hash(:sha256, "attendance_pending_leave"),
          UUID.dump!(participant.participant_id),
          %{"participant_id" => participant.participant_id}
        ]
    )

    {:ok, ending} = Operation.new("attendance_end_0003", :tenant_end_episode, %{})

    assert {:ok, %{external_operation_id: end_id}} =
             Postgres.begin_internal_operation(fixture.episode, ending)

    assert {:ok, _} =
             Postgres.finalize_operation(fixture.episode, end_id, {:confirmed, :provider})

    assert {:ok, %{result: :superseded}} =
             Postgres.apply_lifecycle_intent(fixture.episode, intent_id)

    assert length(Enum.filter(events(connection, fixture), &(&1["event"] == "participant.left"))) ==
             2
  end

  defp prepare_deadline(connection, fixture, :maximum_duration_expired) do
    Postgrex.query!(
      connection,
      "update episodes set deadline_at = now() - interval '1 second', deadline_generation = deadline_generation + 1 where id = $1",
      [UUID.dump!(fixture.episode.episode_id)]
    )
  end

  defp prepare_deadline(_connection, _fixture, _name), do: :ok

  defp begin_end(fixture, :end_episode, operation),
    do: Postgres.begin_operation(hd(fixture.identities), operation)

  defp begin_end(fixture, _name, operation),
    do: Postgres.begin_internal_operation(fixture.episode, operation)

  defp end_payload(:maximum_duration_expired), do: %{"deadlineGeneration" => 2}
  defp end_payload(_name), do: %{}

  defp fixture(connection, count) do
    connection
    |> SyncPostgres.seed_episode(count)
    |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left", "episode.ended"])
  end

  defp events(connection, fixture) do
    Postgrex.query!(
      connection,
      "select body from webhook_events where tenant_id = $1 order by created_at, event_name desc, resource_id",
      [UUID.dump!(fixture.episode.tenant_id)]
    ).rows
    |> Enum.map(fn [body] -> JSON.decode!(body) end)
  end

  defp assert_departures(connection, fixture, count) do
    rows = events(connection, fixture)
    assert length(rows) == count + 1
    episode = List.last(rows)
    assert episode["event"] == "episode.ended"

    Enum.each(Enum.take(rows, count), fn event ->
      assert event["event"] == "participant.left"
      assert event["data"]["object"]["reason"] == "episode_ended"
      assert event["data"]["object"]["left_at"] == episode["data"]["object"]["ended_at"]
      assert event["occurred_at"] == episode["occurred_at"]
    end)

    [[count_in_ledger]] =
      Postgrex.query!(
        connection,
        "select count(*) from observability_journey_events where journey_id = (select journey_id from webhook_events where tenant_id = $1 and event_name = 'episode.ended') and name = 'webhook.event.committed' and sequence < (select sequence from observability_journey_events where name = 'webhook.event.committed' and attributes->>'event' = 'episode.ended' and journey_id = (select journey_id from webhook_events where tenant_id = $1 and event_name = 'episode.ended'))",
        [UUID.dump!(fixture.episode.tenant_id)]
      ).rows

    assert count_in_ledger == count
  end
end
