alias ChalkSync.Auth.DevTokenVerifier
alias ChalkSync.Stateholder.Postgres
alias ChalkSync.SyncPostgres
alias ChalkSync.TestProcess

{:ok, _} = Application.ensure_all_started(:chalk_sync)
connections = SyncPostgres.start_connections(System.fetch_env!("CHALK_SYNC_TEST_DATABASE_URL"))
Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
Application.put_env(:chalk_sync, :stateholder, Postgres)
fixture = SyncPostgres.seed_episode(hd(connections), 2)
{:ok, listener} = Bandit.start_link(plug: ChalkSync.Transport.Router, ip: {127, 0, 0, 1}, port: 0)
{:ok, {_, port}} = ThousandIsland.listener_info(listener)

tokens =
  Enum.map(fixture.identities, fn identity ->
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end)

IO.puts(
  "HEARTBEAT_FIXTURE=" <> JSON.encode!(%{url: "ws://127.0.0.1:#{port}/v1/sync", tokens: tokens})
)

try do
  IO.gets("")
after
  TestProcess.stop(listener)
  SyncPostgres.cleanup(hd(connections), fixture.episode)
  Enum.each(connections, &TestProcess.stop/1)
end
