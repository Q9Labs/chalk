defmodule ChalkSync.Operations.ReadinessTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Operations.Readiness

  test "requires two failures to leave ready and three successes spanning five seconds to recover" do
    clock = :atomics.new(1, [])
    probe = Agent.start_link(fn -> {:ok, %{database: "ok"}} end) |> elem(1)
    name = unique_name("Readiness")

    start_supervised!(
      {Readiness,
       name: name,
       auto_probe?: false,
       success_span_ms: 5_000,
       clock: fn -> :atomics.get(clock, 1) end,
       probe_fun: fn -> Agent.get(probe, & &1) end},
      id: name
    )

    assert %{status: "initializing"} = Readiness.probe_now(name)
    :atomics.put(clock, 1, 2_500)
    assert %{status: "initializing"} = Readiness.probe_now(name)
    :atomics.put(clock, 1, 5_000)
    assert %{status: "ready"} = Readiness.probe_now(name)

    Agent.update(probe, fn _ -> {:error, :database_unavailable} end)
    assert %{status: "ready", consecutive_failures: 1} = Readiness.probe_now(name)
    assert %{status: "unready", consecutive_failures: 2} = Readiness.probe_now(name)

    Agent.update(probe, fn _ -> {:ok, %{database: "ok"}} end)
    :atomics.put(clock, 1, 6_000)
    assert %{status: "initializing"} = Readiness.probe_now(name)
    :atomics.put(clock, 1, 8_500)
    assert %{status: "initializing"} = Readiness.probe_now(name)
    :atomics.put(clock, 1, 11_000)
    assert %{status: "ready"} = Readiness.probe_now(name)
  end

  test "health stays responsive while a probe is blocked" do
    parent = self()

    name = unique_name("ReadinessBlocked")

    start_supervised!(
      {Readiness,
       name: name,
       auto_probe?: false,
       probe_fun: fn ->
         send(parent, {:probe_started, self()})

         receive do
           :release -> {:ok, %{database: "ok"}}
         end
       end},
      id: name
    )

    send(name, :probe)
    assert_receive {:probe_started, probe_pid}

    health = Task.async(fn -> Readiness.health(name) end)
    assert %{status: "initializing"} = Task.await(health, 100)

    send(probe_pid, :release)
  end

  test "stopping readiness terminates an in-flight probe" do
    parent = self()
    name = unique_name("ReadinessShutdown")

    start_supervised!(
      {Readiness,
       name: name,
       auto_probe?: false,
       probe_fun: fn ->
         send(parent, {:probe_started, self()})

         receive do
           :release -> {:ok, %{database: "ok"}}
         end
       end},
      id: name
    )

    send(name, :probe)
    assert_receive {:probe_started, probe_pid}
    probe_ref = Process.monitor(probe_pid)

    GenServer.stop(name, :normal)

    assert_receive {:DOWN, ^probe_ref, :process, ^probe_pid, _reason}
  end

  defp unique_name(suffix),
    do: Module.concat(__MODULE__, "#{suffix}#{System.unique_integer([:positive])}")
end
