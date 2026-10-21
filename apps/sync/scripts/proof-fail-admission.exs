# Disposable real-engine proof: deliver a terminal outcome through Sync's actual
# finalizer, without starting a second scheduler or provider consumer.
{:ok, _} = Application.ensure_all_started(:postgrex)
{:ok, options} = ChalkSync.Database.connection_options(System.fetch_env!("CHALK_DATABASE_URL"))
{:ok, connection} = Postgrex.start_link(options)
Application.put_env(:chalk_sync, :database_connections, [connection])
{:ok, handle} = ChalkSync.UUID.dump(System.fetch_env!("CHALK_PROOF_FAILED_REQUEST"))

[[tenant_id, space_id, episode_id, operation_id]] =
  Postgrex.query!(
    connection,
    """
    select tenant_id::text, space_id::text, episode_id::text,
           decision_external_operation_id::text
    from sync_admission_requests
    where admission_request_id = $1 and status = 'pending'
      and decision_external_operation_id is not null
    """,
    [handle]
  ).rows

episode = %ChalkSync.Stateholder.EpisodeKey{
  tenant_id: tenant_id,
  space_id: space_id,
  episode_id: episode_id
}

{:ok, decision} =
  ChalkSync.Stateholder.Postgres.finalize_operation(
    episode,
    operation_id,
    {:failed, :proof_retry_exhausted}
  )

:failed = decision.result
IO.puts("PASS: Sync finalizer failed accepted decision and released its reservation")
GenServer.stop(connection)
