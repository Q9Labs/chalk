defmodule ChalkSync.Diagnostics.ExporterObservabilityTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Diagnostics
  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Diagnostics.Exporter
  alias ChalkSync.Diagnostics.Transport
  alias ChalkSync.Operations.Metrics
  alias ChalkSync.Stateholder.EpisodeKey

  defmodule RetryTransport do
    def append(config, _scope, _events), do: {:retryable, config.test_failure_reason}
  end

  defmodule ResponseTransport do
    def append(config, _scope, _events), do: {:ok, config.test_response}
  end

  @scope %{
    "tenantId" => "10000000-0000-4000-8000-000000000001",
    "spaceId" => "20000000-0000-4000-8000-000000000002",
    "episodeId" => "30000000-0000-4000-8000-000000000003"
  }

  test "retains a bounded failure reason and exposes a dropped batch to health and metrics" do
    suffix = System.unique_integer([:positive])
    buffer = Module.concat(__MODULE__, "Buffer#{suffix}")
    exporter = Module.concat(__MODULE__, "Exporter#{suffix}")
    start_supervised!({Buffer, name: buffer}, id: buffer)

    event = %{
      "eventId" => "diagnostic-event-#{suffix}",
      "producerSequence" => suffix,
      "name" => "sync.connect"
    }

    assert {:ok, []} = Buffer.insert(buffer, @scope, event, JSON.encode!(event))

    start_supervised!(
      {Exporter,
       name: exporter,
       buffer: buffer,
       transport: RetryTransport,
       config: Map.put(valid_config(), :test_failure_reason, :dns_failed),
       interval_ms: 1,
       max_retries: 1},
      id: exporter
    )

    assert eventually(fn -> Exporter.health(exporter).dropped_batches == 1 end)

    assert %{
             status: :degraded,
             failures: 1,
             total_failures: 1,
             dropped: 1,
             dropped_batches: 1,
             last_failure_reason: :dns_failed
           } = Exporter.health(exporter)

    assert get_in(Metrics.snapshot(), [
             :metrics,
             "chalk.sync.diagnostics.export.retry_exhausted",
             :count
           ]) >= 1
  end

  test "classifies transport failures without retaining raw transport details" do
    assert Transport.classify_request_error(:nxdomain) == {:retryable, :dns_failed}
    assert Transport.classify_request_error(:econnrefused) == {:retryable, :connection_refused}

    assert Transport.classify_request_error({:tls_alert, ~c"private certificate detail"}) ==
             {:retryable, :tls_failed}

    assert Transport.classify_request_error(
             {:failed_connect,
              [
                {:to_address, {~c"private.example", 443}},
                {:inet, [:inet], {:tls_alert, ~c"private certificate detail"}}
              ]}
           ) == {:retryable, :tls_failed}

    assert Transport.classify_request_error({:unexpected, "private failure detail"}) ==
             {:retryable, :transport_error}
  end

  test "retains coverage gaps for terminal exporter failures" do
    previous = Application.get_env(:chalk_sync, :episode_diagnostics)
    buffer = Module.concat(__MODULE__, "GapBuffer#{System.unique_integer([:positive])}")
    start_supervised!({Buffer, name: buffer}, id: buffer)
    Application.put_env(:chalk_sync, :episode_diagnostics, %{mode: :localhost, buffer: buffer})
    on_exit(fn -> Application.put_env(:chalk_sync, :episode_diagnostics, previous) end)

    scope = %EpisodeKey{
      tenant_id: "10000000-0000-4000-8000-000000000001",
      space_id: "20000000-0000-4000-8000-000000000002",
      episode_id: "30000000-0000-4000-8000-000000000003"
    }

    assert :ok = Diagnostics.gap(scope, :credential_unavailable, 1)
    assert :ok = Diagnostics.gap(scope, :response_too_large, 1)
    assert {:ok, _scope, entries} = Buffer.take_batch(buffer, 2, 16 * 1024)

    assert Enum.map(entries, & &1.event["attributes"]["reason"]) == [
             "credential_unavailable",
             "response_too_large"
           ]
  end

  test "a fingerprint conflict remains degraded even when the intake response is otherwise valid" do
    suffix = System.unique_integer([:positive])
    event_id = "diagnostic-conflict-#{suffix}"
    buffer = Module.concat(__MODULE__, "ConflictBuffer#{suffix}")
    exporter = Module.concat(__MODULE__, "ConflictExporter#{suffix}")
    start_supervised!({Buffer, name: buffer}, id: buffer)

    event = %{
      "eventId" => event_id,
      "producerSequence" => suffix,
      "name" => "sync.connect"
    }

    assert {:ok, []} = Buffer.insert(buffer, @scope, event, JSON.encode!(event))

    response = %{accepted: [], duplicates: [], conflicts: [event_id]}

    start_supervised!(
      {Exporter,
       name: exporter,
       buffer: buffer,
       transport: ResponseTransport,
       config: Map.put(valid_config(), :test_response, response),
       interval_ms: 1},
      id: exporter
    )

    assert eventually(fn -> Exporter.health(exporter).dropped_batches == 1 end)

    assert %{
             status: :degraded,
             dropped: 1,
             dropped_batches: 1,
             last_failure_reason: :fingerprint_conflict
           } = Exporter.health(exporter)
  end

  defp valid_config do
    %{
      mode: :localhost,
      base_url: "http://127.0.0.1:4000",
      allowed_hosts: ["127.0.0.1"],
      token: String.duplicate("x", 16),
      instance_id: "diagnostics-test-instance",
      generation: 1,
      connect_timeout_ms: 100,
      request_timeout_ms: 100,
      max_request_bytes: 32 * 1024
    }
  end

  defp eventually(assertion, attempts \\ 100)

  defp eventually(_assertion, 0), do: false

  defp eventually(assertion, attempts) do
    if assertion.() do
      true
    else
      Process.sleep(5)
      eventually(assertion, attempts - 1)
    end
  end
end
