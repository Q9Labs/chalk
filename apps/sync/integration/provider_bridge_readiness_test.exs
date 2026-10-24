ExUnit.start()

defmodule ChalkSync.ProviderBridgeReadinessIntegrationTest do
  use ExUnit.Case

  alias ChalkSync.Operations.Readiness
  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.Config
  alias ChalkSync.SyncPostgres

  @tag timeout: 90_000
  test "slow vendor cleanup cannot starve readiness, but a down bridge does fail readiness" do
    database_url = System.fetch_env!("CHALK_DATABASE_URL")
    Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Postgres)
    Application.put_env(:chalk_sync, :database_url, database_url)
    Application.put_env(:chalk_sync, :port, 0)
    Application.put_env(:chalk_sync, :require_synchronous_standby, false)
    {:ok, _} = Application.ensure_all_started(:chalk_sync)

    connection =
      ChalkSync.Database.connection(%ChalkSync.Stateholder.EpisodeKey{
        tenant_id: "test",
        space_id: "test",
        episode_id: "test"
      })

    fixtures = for _ <- 1..2, do: SyncPostgres.seed_episode(connection)
    directory = System.fetch_env!("CHALK_BRIDGE_TEST_DIRECTORY")

    bridge =
      Port.open({:spawn_executable, String.to_charlist(Path.join(directory, "bridge"))}, [
        :binary,
        :exit_status,
        {:line, 16_384},
        {:args, [String.to_charlist(directory)]}
      ])

    on_exit(fn ->
      if Port.info(bridge), do: Port.close(bridge)
      Enum.each(fixtures, &SyncPostgres.cleanup(connection, &1.episode))
      Application.stop(:chalk_sync)
    end)

    input =
      Enum.map(fixtures, fn f ->
        %{
          Tenant: f.episode.tenant_id,
          Episode: f.episode.episode_id,
          Participant: hd(f.identities).participant_id
        }
      end)

    Port.command(bridge, JSON.encode!(input) <> "\n")

    info =
      receive do
        {^bridge, {:data, {:eol, line}}} -> JSON.decode!(line)
        {^bridge, {:exit_status, status}} -> flunk("API fixture exited: #{status}")
      after
        15_000 -> flunk("API fixture did not start")
      end

    options = [
      base_url: info["base_url"],
      certfile: Path.join(directory, "cert.pem"),
      keyfile: Path.join(directory, "key.pem"),
      cacertfile: Path.join(directory, "ca.pem")
    ]

    Application.put_env(:chalk_sync, :provider_bridge, options)
    client = Config.client!(options, 30_000)
    # Warm a real keep-alive connection before cleanup takes it over.
    assert :ok = Client.ready(client)
    await_status(200)
    assert {:ok, [{:max_sessions, 2}]} = :httpc.get_options([:max_sessions])

    tasks =
      Enum.with_index(fixtures, fn f, index ->
        Task.async(fn ->
          Client.post_operation(client, "readiness-cleanup-#{index}", %{
            "effect" => "media.end_episode",
            "tenant_id" => f.episode.tenant_id,
            "episode_id" => f.episode.episode_id
          })
        end)
      end)

    assert 204 = control(info["control_url"] <> "/wait")
    await_queued_requests(2)
    for _ <- 1..3, do: Readiness.probe_now()
    {status, body} = ready_response()
    IO.puts("cleanup readiness: #{status} #{body}")
    assert status == 200
    assert 204 = control(info["control_url"] <> "/release")
    for task <- tasks, do: assert({:ok, :satisfied} = Task.await(task, 35_000))

    Port.close(bridge)
    await_status(503)
    for _ <- 1..3, do: Readiness.probe_now()
    {status, body} = ready_response()
    IO.puts("bridge down readiness: #{status} #{body}")
    assert status == 503
    assert body =~ "provider_bridge_unavailable"
  end

  defp await_queued_requests(count, attempts \\ 100)
  defp await_queued_requests(_count, 0), do: flunk("cleanup did not enter the shared HTTP pool")

  defp await_queued_requests(count, attempts) do
    handlers = Keyword.fetch!(:httpc.info(), :handlers)

    requests = Enum.sum(Enum.map(handlers, fn {_pid, requests, _info} -> length(requests) end))

    if requests >= count do
      :ok
    else
      Process.sleep(10)
      await_queued_requests(count, attempts - 1)
    end
  end

  defp await_status(status, attempts \\ 100)
  defp await_status(_status, 0), do: flunk("Sync never became ready")

  defp await_status(status, attempts) do
    if elem(ready_response(), 0) == status do
      :ok
    else
      Process.sleep(100)
      await_status(status, attempts - 1)
    end
  end

  defp ready_response do
    {_, listener, _, _} =
      Enum.find(Supervisor.which_children(ChalkSync.Supervisor), fn {id, _, _, _} ->
        id == Bandit
      end)

    {:ok, {_, port}} = ThousandIsland.listener_info(listener)

    {:ok, {{_, status, _}, _, body}} =
      :httpc.request(:get, {~c"http://127.0.0.1:#{port}/readyz", []}, [timeout: 1_000],
        body_format: :binary
      )

    {status, body}
  end

  defp control(url) do
    {:ok, {{_, status, _}, _, _}} =
      :httpc.request(:get, {String.to_charlist(url), []}, [timeout: 5_000], [])

    status
  end
end
