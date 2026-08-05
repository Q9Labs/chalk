defmodule ChalkSync.RealBrowserFixture do
  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

  def run do
    configure!(database_url())
    {:ok, _applications} = Application.ensure_all_started(:chalk_sync)

    {:ok, listener} =
      Bandit.start_link(plug: ChalkSync.Transport.Router, ip: {127, 0, 0, 1}, port: 0)

    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)
    fixture = SyncPostgres.seed_pending_join(Database.connection(browser_episode()))

    try do
      emit_fixture(port, fixture)
      IO.gets("")
    after
      if Process.alive?(listener), do: GenServer.stop(listener)
      SyncPostgres.cleanup(Database.connection(fixture.episode), fixture.episode)
      Application.stop(:chalk_sync)
    end
  end

  defp configure!(database_url) do
    Application.put_env(:chalk_sync, :database_url, database_url)
    Application.put_env(:chalk_sync, :database_pool_size, 4)
    Application.put_env(:chalk_sync, :port, :none)
    Application.put_env(:chalk_sync, :stateholder, Postgres)
  end

  defp database_url do
    System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
      System.get_env("CHALK_DATABASE_URL") ||
      raise "CHALK_SYNC_TEST_DATABASE_URL must be set"
  end

  defp browser_episode do
    %ChalkSync.Stateholder.EpisodeKey{
      tenant_id: "browser",
      space_id: "browser",
      episode_id: "browser"
    }
  end

  defp emit_fixture(port, fixture) do
    identity = fixture.identity

    token =
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

    IO.puts(
      "CHALK_SYNC_BROWSER_FIXTURE=" <>
        JSON.encode!(%{url: "ws://127.0.0.1:#{port}/v1/sync", token: token})
    )
  end
end

ChalkSync.RealBrowserFixture.run()
