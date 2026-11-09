alias ChalkSync.Stateholder.{EpisodeKey, Identity, Operation, Postgres}
alias ChalkSync.SyncPostgres
[action, tenant, space, episode_id, participant, intent] = System.argv()
episode = %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode_id}

identity = %Identity{
  episode: episode,
  participant_id: participant,
  participant_generation: 1,
  admission_lifecycle_intent_id: intent,
  role: "owner",
  capabilities: ChalkSync.Episodes.Reducer.new(episode_id).role_capabilities["owner"]
}

connections = SyncPostgres.start_connections(System.fetch_env!("CHALK_SYNC_TEST_DATABASE_URL"))
Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

result =
  case action do
    "join" ->
      Postgres.apply_lifecycle_intent(episode, intent)

    "leave" ->
      {:ok, operation} = Operation.new("production_670_leave", :participant_leave, %{})

      case Postgres.begin_operation(identity, operation) do
        {:ok, %{result: :pending, external_operation_id: id}} ->
          Postgres.finalize_operation(episode, id, {:confirmed, :provider})

        other ->
          other
      end

    "finalize" ->
      [[id]] =
        Postgrex.query!(
          hd(connections),
          "select external_operation_id from sync_external_operations where target_participant_id=$1 and operation_name='participant_leave'",
          [ChalkSync.UUID.dump!(participant)]
        ).rows

      Postgres.finalize_operation(episode, ChalkSync.UUID.load!(id), {:confirmed, :provider})

    "claim" ->
      Postgres.claim_operations(64)

    "accept" ->
      {:ok, operation} = Operation.new("production_670_leave", :participant_leave, %{})
      Postgres.begin_operation(identity, operation)
  end

IO.puts("PRODUCTION_670_RESULT " <> inspect(result))

case result do
  {:ok, _} -> :ok
  _ -> System.halt(10)
end
