defmodule ChalkSync.Operations.ReadinessTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Operations.Readiness

  setup do
    results = start_supervised!({Agent, fn -> [] end}, id: :scripted_probe_results)
    time = start_supervised!({Agent, fn -> 0 end}, id: :fake_clock)

    probe_fun = fn ->
      Agent.get_and_update(results, fn [result | remaining] -> {result, remaining} end)
    end

    clock = fn -> Agent.get(time, & &1) end

    readiness =
      start_supervised!(
        {Readiness,
         name: nil, auto_probe?: false, probe_fun: probe_fun, clock: clock, success_span_ms: 500},
        id: :scripted_readiness
      )

    %{readiness: readiness, results: results, time: time}
  end

  test "logs the initial transition to ready", context do
    script(context, [{:ok, %{}}, {:ok, %{}}, {:ok, %{}}])

    log =
      capture_readiness_log(fn ->
        assert probe_at(context, 0).status == "initializing"
        assert probe_at(context, 250).status == "initializing"
        assert probe_at(context, 500).status == "ready"
      end)

    assert changed_event_count(log) == 1
    assert log =~ "\"from\":\"initializing\""
    assert log =~ "\"to\":\"ready\""
    assert log =~ "\"reason\":\"none\""
    assert log =~ "\"consecutive_failures\":0"
  end

  test "logs only the hysteretic transition to unready", context do
    become_ready(context)
    script(context, [{:error, :database_unavailable}])

    first_failure_log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert probe_at(context, 600).status == "ready"
      end)

    refute first_failure_log =~ "\"event\":\"sync.readiness.changed\""

    script(context, [{:error, :database_unavailable}])

    second_failure_log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert probe_at(context, 700).status == "unready"
      end)

    assert changed_event_count(second_failure_log) == 1
    assert second_failure_log =~ "\"from\":\"ready\""
    assert second_failure_log =~ "\"to\":\"unready\""
    assert second_failure_log =~ "\"reason\":\"database_unavailable\""
    assert second_failure_log =~ "\"consecutive_failures\":2"

    script(context, [{:error, :database_unavailable}])

    further_failure_log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert probe_at(context, 800).status == "unready"
      end)

    refute further_failure_log =~ "\"event\":\"sync.readiness.changed\""
  end

  test "logs recovery once with elapsed unready time", context do
    become_ready(context)
    script(context, [{:error, :database_unavailable}, {:error, :database_unavailable}])

    failure_log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert probe_at(context, 600).status == "ready"
        assert probe_at(context, 700).status == "unready"
      end)

    assert changed_event_count(failure_log) == 1

    script(context, [{:ok, %{}}, {:ok, %{}}, {:ok, %{}}])

    recovery_log =
      capture_readiness_log(fn ->
        assert probe_at(context, 800).status == "unready"
        assert probe_at(context, 1_050).status == "unready"
        assert probe_at(context, 1_300).status == "ready"
      end)

    assert changed_event_count(recovery_log) == 1
    assert recovery_log =~ "\"from\":\"unready\""
    assert recovery_log =~ "\"to\":\"ready\""
    assert recovery_log =~ "\"reason\":\"none\""
    assert recovery_log =~ "\"consecutive_failures\":0"
    assert recovery_log =~ "\"unready_ms\":600"
  end

  for {fault, observed} <- [exception: "exception", killed: "terminated"] do
    @fault fault
    @observed observed

    test "logs a #{@fault} probe worker without private failure text" do
      probe = fn ->
        case @fault do
          :exception -> raise "private failure text must not escape"
          :killed -> Process.exit(self(), :kill)
        end
      end

      readiness =
        start_supervised!({Readiness, name: nil, auto_probe?: false, probe_fun: probe})

      log =
        ExUnit.CaptureLog.capture_log(fn ->
          health = Readiness.probe_now(readiness)
          assert health.status == "unready"
          assert health.dependencies == %{reason: "probe_failed"}
        end)

      assert log =~ "\"event\":\"sync.readiness.failed\""
      assert log =~ "\"check\":\"probe_worker\""
      assert log =~ "\"observed\":\"#{@observed}\""
      refute log =~ "private failure text"
    end
  end

  defp become_ready(context) do
    script(context, [{:ok, %{}}, {:ok, %{}}, {:ok, %{}}])
    probe_at(context, 0)
    probe_at(context, 250)
    probe_at(context, 500)
  end

  defp probe_at(context, now) do
    Agent.update(context.time, fn _current -> now end)
    Readiness.probe_now(context.readiness)
  end

  defp script(context, results) do
    Agent.update(context.results, fn _current -> results end)
  end

  defp changed_event_count(log) do
    length(Regex.scan(~r/"event":"sync\.readiness\.changed"/, log))
  end

  defp capture_readiness_log(fun) do
    previous_level = Logger.level()
    Logger.configure(level: :info)

    try do
      ExUnit.CaptureLog.capture_log(fun)
    after
      Logger.configure(level: previous_level)
    end
  end
end
