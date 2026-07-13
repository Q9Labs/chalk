defmodule ChalkSync.ProviderBridge.E2ETest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @enabled System.get_env("CHALK_PROVIDER_BRIDGE_E2E") == "1"
  @base_url System.get_env("CHALK_PROVIDER_BRIDGE_E2E_URL")
  @certfile System.get_env("CHALK_PROVIDER_BRIDGE_E2E_CERTFILE")
  @keyfile System.get_env("CHALK_PROVIDER_BRIDGE_E2E_KEYFILE")
  @cacertfile System.get_env("CHALK_PROVIDER_BRIDGE_E2E_CAFILE")
  @database_url System.get_env("CHALK_PROVIDER_BRIDGE_E2E_DATABASE_URL") ||
                  System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if not @enabled or
       Enum.any?([@base_url, @certfile, @keyfile, @cacertfile, @database_url], &is_nil/1) do
    @moduletag skip:
                 "set cross-runtime provider bridge URL, mTLS files, database, and enable flag"
  end

  setup_all do
    if @enabled and @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url, 4)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        if previous_connections,
          do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
          else: Application.delete_env(:chalk_sync, :database_connections)

        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  test "claims a durable mute, crosses mTLS provider bridge, and finalizes exactly once", %{
    connections: connections
  } do
    fixture = SyncPostgres.seed_session(hd(connections), 2)

    on_exit(fn ->
      cleanup_provider_bridge_rows(hd(connections), fixture.session)
      SyncPostgres.cleanup(hd(connections), fixture.session)
    end)

    [host, guest] = fixture.identities

    {:ok, operation} =
      Operation.new("cross_runtime_mute_01", :mute_participant, %{
        "participantSessionId" => guest.participant_session_id
      })

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(host, operation)

    assert {:ok, claimed} = Postgres.claim_operations(64)

    assert {session, external} =
             Enum.find(claimed, fn {_session, candidate} ->
               candidate.external_operation_id == operation_id
             end)

    client =
      Client.new!(
        base_url: @base_url,
        certfile: @certfile,
        keyfile: @keyfile,
        cacertfile: @cacertfile
      )

    adapter = MediaPlane.new!(client)

    assert :confirmed =
             ExternalOperationConsumer.execute_operation(
               session,
               external,
               {MediaPlane, adapter},
               nil,
               &Postgres.finalize_operation/3
             )

    assert {:ok, %{status: :applied, attempt_count: 1}} =
             Postgres.read_operation(fixture.session, operation_id)

    assert {:ok, remaining} = Postgres.claim_operations(64)

    refute Enum.any?(remaining, fn {_session, candidate} ->
             candidate.external_operation_id == operation_id
           end)
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end

  defp cleanup_provider_bridge_rows(connection, session) do
    params = [UUID.dump!(session.tenant_id), UUID.dump!(session.session_id)]

    Postgrex.query!(
      connection,
      "delete from provider_operation_observations where tenant_id = $1 and session_id = $2",
      params
    )

    Postgrex.query!(
      connection,
      "delete from provider_operation_observation_heads where tenant_id = $1 and session_id = $2",
      params
    )

    Postgrex.query!(
      connection,
      "delete from provider_operation_receipts where tenant_id = $1 and session_id = $2",
      params
    )
  end
end
