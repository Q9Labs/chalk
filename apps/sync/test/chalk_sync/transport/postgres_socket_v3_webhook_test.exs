defmodule ChalkSync.Transport.PostgresSocketV3WebhookTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Operations.Metrics
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connection: hd(connections)}
    else
      :ok
    end
  end

  test "v3 WebSocket continues upgrade context through leave and end webhook fanout", %{
    connection: connection,
    port: port
  } do
    leave_seed = SyncPostgres.seed_session(connection, 2)
    end_seed = SyncPostgres.seed_session(connection)
    provider_seed = SyncPostgres.seed_session(connection, 2)

    leave_fixture =
      %{session: leave_seed.session, identity: Enum.at(leave_seed.identities, 1)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["participant.left"])

    end_fixture =
      %{session: end_seed.session, identity: hd(end_seed.identities)}
      |> SyncPostgres.seed_webhook_endpoint(connection, ["session.ended"])

    provider_fixture = %{
      session: provider_seed.session,
      identity: hd(provider_seed.identities),
      target: Enum.at(provider_seed.identities, 1)
    }

    on_exit(fn -> SyncPostgres.cleanup(connection, leave_fixture.session) end)
    on_exit(fn -> SyncPostgres.cleanup(connection, end_fixture.session) end)
    on_exit(fn -> SyncPostgres.cleanup(connection, provider_fixture.session) end)

    {:ok, media_plane} =
      MediaPlaneTestAdapter.start_link(outcomes: %{revoke_publication: :ambiguous})

    start_supervised!(
      {ExternalOperationConsumer,
       poll_interval_ms: 10,
       page_size: 8,
       max_backoff_ms: 100,
       media_plane: {MediaPlaneTestAdapter, media_plane}}
    )

    leave_context = context(1)
    end_context = context(2)

    metrics_before = Metrics.snapshot().metrics

    accept_operation(
      port,
      provider_fixture.identity,
      "ws_provider_operation01",
      "mute_participant",
      %{"participant_session_id" => provider_fixture.target.participant_session_id},
      context(3)
    )

    accept_operation(
      port,
      leave_fixture.identity,
      "ws_leave_operation_01",
      "participant_leave",
      %{},
      leave_context
    )

    accept_operation(
      port,
      end_fixture.identity,
      "ws_end_operation_0001",
      "end_session",
      %{},
      end_context
    )

    assert_webhook_chain(
      connection,
      leave_fixture,
      "ws_leave_operation_01",
      "participant.left",
      leave_context
    )

    assert_webhook_chain(
      connection,
      end_fixture,
      "ws_end_operation_0001",
      "session.ended",
      end_context
    )

    assert_provider_operation_pending(connection, provider_fixture, "ws_provider_operation01")
    assert_webhook_metrics(metrics_before)
  end

  defp accept_operation(port, identity, request_key, operation_name, payload, context) do
    headers = [
      {"x-chalk-journey-id", context.journey_id},
      {"traceparent", "00-#{context.trace_id}-#{context.span_id}-01"}
    ]

    {:ok, client} = Client.connect(port, "/v3/sync", headers)
    client = Client.send_json(client, hello(identity))
    {:json, %{"type" => "welcome", "protocol" => 3} = welcome, client} = Client.recv(client)
    client = Client.acknowledge_recovery(client, welcome)
    {:json, %{"type" => "recovery_complete"}, client} = Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "media"}, client} =
      Client.recv(client)

    {:json, %{"type" => "projection_snapshot", "stream" => "presence"}, client} =
      Client.recv(client)

    client =
      Client.send_json(client, %{
        "type" => "operation",
        "command_id" => request_key,
        "name" => operation_name,
        "payload" => payload
      })

    assert {:json,
            %{
              "type" => "retryable_error",
              "command_id" => ^request_key,
              "code" => "external_operation_pending"
            }, client} = Client.recv(client)

    _client = Client.close(client)
    :ok
  end

  defp assert_webhook_chain(connection, fixture, request_key, event_name, context) do
    tenant_id = UUID.dump!(fixture.session.tenant_id)

    assert [
             [
               ^event_name,
               journey_id,
               parent_event_id,
               trace_id,
               span_id,
               "pending",
               delivery_journey_event_id
             ]
           ] =
             await_rows(fn ->
               Postgrex.query!(
                 connection,
                 """
                 select e.event_name, e.journey_id, e.parent_journey_event_id,
                        e.producing_trace_id, e.producing_span_id,
                        d.state, d.queued_journey_event_id
                 from webhook_events e
                 join webhook_deliveries d
                   on d.tenant_id = e.tenant_id and d.event_id = e.id
                 where e.tenant_id = $1 and e.event_name = $2
                 """,
                 [tenant_id, event_name]
               ).rows
             end)

    assert UUID.load!(journey_id) == context.journey_id
    assert trace_id == context.trace_id
    assert span_id == context.span_id

    journey_rows =
      Postgrex.query!(
        connection,
        """
        select name, parent_event_id, event_id
        from observability_journey_events
        where journey_id = $1
        order by sequence
        """,
        [journey_id]
      ).rows

    assert [
             ["sync.external_operation.accepted", nil, accepted_event_id],
             ["webhook.event.committed", committed_parent_event_id, committed_event_id],
             ["webhook.delivery.queued", queued_parent_event_id, queued_event_id]
           ] = journey_rows

    assert parent_event_id == accepted_event_id
    assert committed_parent_event_id == accepted_event_id
    assert queued_parent_event_id == committed_event_id
    assert queued_event_id == delivery_journey_event_id

    assert [[operation_id, stored_parent_event_id, "applied", attempt_count]] =
             Postgrex.query!(
               connection,
               """
               select external_operation_id, parent_journey_event_id, status, attempt_count
               from sync_external_operations
               where tenant_id = $1 and request_key = $2
               """,
               [tenant_id, request_key]
             ).rows

    assert is_binary(operation_id)
    assert stored_parent_event_id == accepted_event_id
    assert attempt_count >= 1
  end

  defp assert_provider_operation_pending(connection, fixture, request_key) do
    assert [["pending", attempt_count]] =
             Postgrex.query!(
               connection,
               """
               select status, attempt_count
               from sync_external_operations
               where tenant_id = $1 and request_key = $2
               """,
               [UUID.dump!(fixture.session.tenant_id), request_key]
             ).rows

    assert attempt_count >= 1
  end

  defp assert_webhook_metrics(before) do
    snapshot = Metrics.snapshot().metrics

    for event_name <- ["participant_left", "session_ended"],
        phase <- ["production.committed", "fanout.queued"] do
      metric = "chalk.sync.webhook.#{phase}.#{event_name}.v1"
      before_count = get_in(before, [metric, :count]) || 0
      assert get_in(snapshot, [metric, :count]) == before_count + 1
    end
  end

  defp await_rows(query, attempts \\ 100)
  defp await_rows(_query, 0), do: flunk("timed out waiting for supervised webhook finalization")

  defp await_rows(query, attempts) do
    case query.() do
      [] ->
        Process.sleep(20)
        await_rows(query, attempts - 1)

      rows ->
        rows
    end
  end

  defp hello(identity) do
    token =
      DevTokenVerifier.token(%{
        "tenant_id" => identity.session.tenant_id,
        "room_id" => identity.session.room_id,
        "session_id" => identity.session.session_id,
        "participant_id" => identity.participant_session_id,
        "participant_session_id" => identity.participant_session_id,
        "participant_session_generation" => identity.participant_session_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "initial_role" => identity.role || "participant",
        "eligible_roles" =>
          if(identity.eligible_roles == [], do: ["participant"], else: identity.eligible_roles),
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })

    %{
      "type" => "hello",
      "protocol" => 3,
      "token" => token,
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }
  end

  defp context(_index) do
    %{
      journey_id: UUID.generate(),
      trace_id: random_hex(16),
      span_id: random_hex(8)
    }
  end

  defp random_hex(bytes), do: bytes |> :crypto.strong_rand_bytes() |> Base.encode16(case: :lower)

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
