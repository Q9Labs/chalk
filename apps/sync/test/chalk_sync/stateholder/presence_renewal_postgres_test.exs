defmodule ChalkSync.Stateholder.PresenceRenewalPostgresTest do
  use ChalkSync.PostgresCase, async: false

  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  test "records committed renewal, expiry and stale generation separately", %{
    connection: connection
  } do
    %{episode: episode, identities: [identity]} = SyncPostgres.seed_episode(connection)
    participant = identity.participant_id
    params = Scope.participant(identity)
    on_exit(fn -> SyncPostgres.cleanup(connection, episode) end)

    test = self()
    handler = {__MODULE__, test}

    :ok =
      :telemetry.attach(
        handler,
        [:chalk_sync, :obs, :record],
        &__MODULE__.forward_renewal/4,
        {test, participant}
      )

    on_exit(fn -> :telemetry.detach(handler) end)

    assert :ok = Postgres.renew_presence(identity)
    assert_receive {:presence_renewal, "renewed"}

    assert %{num_rows: 1} =
             Postgrex.query!(
               connection,
               """
               update participant_presence_leases set expires_at = now() - interval '1 second'
               where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4
               """,
               params
             )

    assert :ok = Postgres.renew_presence(identity)
    assert_receive {:presence_renewal, "renewed_after_expiry"}

    assert :ok = Postgres.renew_presence(%{identity | participant_generation: 2})
    assert_receive {:presence_renewal, "not_renewed"}

    assert %{rows: [[1, true]]} =
             Postgrex.query!(
               connection,
               """
               select generation, expires_at > now() from participant_presence_leases
               where tenant_id=$1 and space_id=$2 and episode_id=$3 and participant_id=$4
               """,
               params
             )

    missing_episode = %{episode | episode_id: UUID.generate()}

    assert {:error, :episode_not_found} =
             Postgres.renew_presence(%{identity | episode: missing_episode})

    assert_receive {:presence_renewal, "unconfirmed"}
  end

  def forward_renewal(_event, _measurements, record, {test, participant}) do
    case record do
      %{
        "name" => "sync.presence_renewal",
        "participant_id" => ^participant,
        "presence_renewal" => result
      } ->
        send(test, {:presence_renewal, result})

      _ ->
        :ok
    end
  end
end
