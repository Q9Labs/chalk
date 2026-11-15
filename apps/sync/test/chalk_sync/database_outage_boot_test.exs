defmodule ChalkSync.DatabaseOutageBootTest do
  # Boots the real application with production boot checks while the database is unreachable
  # (a path to the database that has no listener), then opens the path. Sync must stay up and
  # report not ready during the outage, keep sockets out until the presence witness is written,
  # and become ready by itself afterwards.
  use ExUnit.Case, async: false

  alias ChalkSync.Operations
  alias ChalkSync.Operations.Readiness

  @settings [
    database_url: nil,
    database_workers: true,
    database_pool_size: 2,
    enforce_production_boot_checks: true,
    port: 0
  ]

  setup do
    saved =
      Map.new(@settings, fn {key, _value} -> {key, Application.fetch_env(:chalk_sync, key)} end)

    serving_key = {Operations, :serving}
    upstream = upstream(ChalkSync.SyncPostgres.database_url!())
    proxy_port = free_port()

    :ok = Application.stop(:chalk_sync)
    :persistent_term.erase(serving_key)

    for {key, value} <- @settings do
      Application.put_env(:chalk_sync, key, value || proxied_url(upstream, proxy_port))
    end

    on_exit(fn ->
      Application.stop(:chalk_sync)
      :persistent_term.erase(serving_key)

      for {key, value} <- saved do
        case value do
          {:ok, previous} -> Application.put_env(:chalk_sync, key, previous)
          :error -> Application.delete_env(:chalk_sync, key)
        end
      end

      {:ok, _started} = Application.ensure_all_started(:chalk_sync)
    end)

    %{upstream: upstream, proxy_port: proxy_port}
  end

  test "Sync boots while the database is away and becomes ready when it returns", context do
    assert {:ok, _started} = Application.ensure_all_started(:chalk_sync)

    health = await(fn -> unready_with_reason(Readiness.health()) end)
    assert health.status == "unready"
    assert health.dependencies.reason == "database_unavailable"
    refute Readiness.ready?()
    refute Operations.serving?()
    refute Operations.accepting_connections?()
    assert Process.whereis(ChalkSync.Fanout.PostgresNotifications)
    assert Process.whereis(ChalkSync.Supervisor)

    proxy = start_proxy(context.proxy_port, context.upstream)

    await(fn -> Readiness.ready?() end, 60_000)
    assert Operations.serving?()
    assert Operations.accepting_connections?()
    assert Readiness.health().status == "ready"

    # A second loss and recovery needs no restart either.
    Process.exit(proxy, :kill)
    await(fn -> not Readiness.ready?() end, 30_000)
    assert Process.whereis(ChalkSync.Supervisor)
    start_proxy(context.proxy_port, context.upstream)
    await(fn -> Readiness.ready?() end, 60_000)
  end

  defp unready_with_reason(%{dependencies: %{reason: _reason}} = health), do: health
  defp unready_with_reason(_health), do: nil

  defp await(fun, timeout_ms \\ 15_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_await(fun, deadline)
  end

  defp do_await(fun, deadline) do
    case fun.() do
      result when result in [nil, false] ->
        if System.monotonic_time(:millisecond) > deadline,
          do: flunk("condition was not reached in time")

        Process.sleep(200)
        do_await(fun, deadline)

      result ->
        result
    end
  end

  defp upstream(url) do
    uri = URI.parse(url)
    %{uri: uri, host: String.to_charlist(uri.host), port: uri.port || 5432}
  end

  defp proxied_url(upstream, proxy_port) do
    URI.to_string(%{upstream.uri | host: "127.0.0.1", port: proxy_port})
  end

  defp free_port do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(listener)
    :gen_tcp.close(listener)
    port
  end

  # A TCP forwarder that stands in for the network path to the database. Killing it closes every
  # socket it owns, which is what a database outage looks like to Postgrex.
  defp start_proxy(port, upstream) do
    parent = self()

    pid =
      spawn(fn ->
        {:ok, listener} =
          :gen_tcp.listen(port, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])

        send(parent, :proxy_listening)
        accept_loop(listener, upstream)
      end)

    assert_receive :proxy_listening, 5_000
    pid
  end

  defp accept_loop(listener, upstream) do
    {:ok, client} = :gen_tcp.accept(listener)

    {:ok, server} =
      :gen_tcp.connect(upstream.host, upstream.port, [:binary, active: false], 5_000)

    owner = self()

    for {from, to} <- [{client, server}, {server, client}],
        do: spawn_link(fn -> relay(owner, from, to) end)

    accept_loop(listener, upstream)
  end

  defp relay(owner, from, to) do
    with {:ok, data} <- :gen_tcp.recv(from, 0),
         :ok <- :gen_tcp.send(to, data) do
      relay(owner, from, to)
    else
      _closed ->
        :gen_tcp.close(from)
        :gen_tcp.close(to)
    end
  end
end
