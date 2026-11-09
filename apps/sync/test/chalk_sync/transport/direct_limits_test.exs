defmodule ChalkSync.Transport.DirectLimitsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Transport.DirectLimits

  @ip "203.0.113.7"

  setup context do
    options =
      Keyword.merge(
        [
          name: :"direct_limits_#{System.unique_integer([:positive])}",
          window_ms: 1_000,
          upgrades_per_ip_window: 3,
          max_sockets_per_ip: 2,
          max_unauthenticated_per_ip: 2,
          max_sockets_per_tenant: 2,
          tracked_ip_limit: 2
        ],
        Map.get(context, :limits, [])
      )

    {:ok, limits: start_supervised!({DirectLimits, options})}
  end

  # A socket process: registers (and optionally authenticates), reports back, then waits to be stopped.
  defp socket(limits, ip, tenant_id \\ nil) do
    parent = self()

    pid =
      spawn(fn ->
        registered = DirectLimits.register(limits, ip)

        bound =
          if tenant_id && registered == :ok, do: DirectLimits.authenticated(limits, tenant_id)

        send(parent, {:socket, self(), registered, bound})

        receive do
          :stop -> :ok
        end
      end)

    assert_receive {:socket, ^pid, registered, bound}
    {pid, registered, bound}
  end

  defp stop(pid) do
    ref = Process.monitor(pid)
    send(pid, :stop)
    assert_receive {:DOWN, ^ref, :process, ^pid, _reason}
    # The limiter handles its own DOWN message before any later call.
    :ok
  end

  test "an IP over its concurrent socket bound is refused until a socket exits", %{limits: limits} do
    {first, :ok, _} = socket(limits, @ip, "t1")
    {_second, :ok, _} = socket(limits, @ip, "t2")

    assert {_third, {:error, :ip_limit}, _} = socket(limits, @ip)
    assert {:error, :ip_limit} = DirectLimits.admit_upgrade(limits, @ip, 0)

    stop(first)
    assert {_replacement, :ok, _} = socket(limits, @ip, "t3")
  end

  test "unauthenticated sockets are bounded per IP and freed by hello", %{limits: limits} do
    {_a, :ok, nil} = socket(limits, @ip)
    {_b, :ok, nil} = socket(limits, @ip)

    assert {_c, {:error, :ip_limit}, _} = socket(limits, @ip)
    assert {:error, :ip_limit} = DirectLimits.admit_upgrade(limits, @ip, 0)
    assert :ok = DirectLimits.admit_upgrade(limits, "198.51.100.1", 0)
  end

  test "authenticating moves a socket out of the unauthenticated bound", %{limits: limits} do
    {_a, :ok, :ok} = socket(limits, @ip, "t1")
    {_b, :ok, :ok} = socket(limits, @ip, "t2")

    assert %{sockets: 2, tenants: 2} = DirectLimits.stats(limits)
  end

  test "a tenant over its concurrent socket bound is refused across IPs", %{limits: limits} do
    {first, :ok, :ok} = socket(limits, "198.51.100.1", "tenant")
    {_second, :ok, :ok} = socket(limits, "198.51.100.2", "tenant")

    assert {_third, :ok, {:error, :tenant_limit}} = socket(limits, "198.51.100.3", "tenant")
    assert {_other, :ok, :ok} = socket(limits, "198.51.100.4", "other-tenant")

    stop(first)
    assert {_again, :ok, :ok} = socket(limits, "198.51.100.5", "tenant")
  end

  test "a crashed socket releases its IP and tenant slots", %{limits: limits} do
    {pid, :ok, :ok} = socket(limits, @ip, "tenant")
    Process.exit(pid, :kill)
    ref = Process.monitor(pid)
    assert_receive {:DOWN, ^ref, :process, ^pid, _reason}

    assert %{sockets: 0, ips: 0, tenants: 0} = DirectLimits.stats(limits)
  end

  test "upgrade attempts per IP are limited over a window and recover after it", %{limits: limits} do
    for at <- [0, 100, 200], do: assert(:ok = DirectLimits.admit_upgrade(limits, @ip, at))

    assert {:error, :rate_limited} = DirectLimits.admit_upgrade(limits, @ip, 300)
    assert :ok = DirectLimits.admit_upgrade(limits, "198.51.100.1", 300)
    assert :ok = DirectLimits.admit_upgrade(limits, @ip, 1_300)
  end

  test "tracking many source IPs stays bounded", %{limits: limits} do
    assert :ok = DirectLimits.admit_upgrade(limits, "198.51.100.1", 0)
    assert :ok = DirectLimits.admit_upgrade(limits, "198.51.100.2", 0)

    assert {:error, :overloaded} = DirectLimits.admit_upgrade(limits, "198.51.100.3", 0)
    assert :ok = DirectLimits.admit_upgrade(limits, "198.51.100.3", 2_000)
  end

  test "an unreachable limiter refuses instead of admitting" do
    assert {:error, :overloaded} = DirectLimits.admit_upgrade(:direct_limits_not_running, @ip, 0)
  end

  test "only the proxy marker makes a request direct" do
    marked =
      Plug.Test.conn(:get, "/v1/sync") |> Plug.Conn.put_req_header("x-chalk-ingress", "direct")

    assert DirectLimits.direct?(marked)
    refute DirectLimits.direct?(Plug.Test.conn(:get, "/v1/sync"))

    refute DirectLimits.direct?(
             Plug.Test.conn(:get, "/v1/sync")
             |> Plug.Conn.put_req_header("x-chalk-ingress", "tunnel")
           )
  end
end
