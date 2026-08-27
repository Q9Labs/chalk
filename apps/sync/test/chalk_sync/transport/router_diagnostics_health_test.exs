defmodule ChalkSync.Transport.RouterDiagnosticsHealthTest do
  use ExUnit.Case, async: false

  import Plug.Test

  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Diagnostics.Exporter
  alias ChalkSync.Transport.Router

  setup do
    previous = Application.get_env(:chalk_sync, :episode_diagnostics)

    on_exit(fn -> Application.put_env(:chalk_sync, :episode_diagnostics, previous) end)

    :ok
  end

  test "returns unavailable when Episode Diagnostic delivery is disabled" do
    Application.put_env(:chalk_sync, :episode_diagnostics, %{mode: :off})

    response = request_health()

    assert response.status == 503
    assert JSON.decode!(response.resp_body) == %{"status" => "disabled"}
  end

  test "returns unavailable when the configured exporter is not running" do
    Application.put_env(:chalk_sync, :episode_diagnostics, valid_config())

    response = request_health()

    assert response.status == 503
    assert JSON.decode!(response.resp_body) == %{"status" => "unavailable"}
  end

  test "returns success only when the configured exporter is healthy" do
    Application.put_env(:chalk_sync, :episode_diagnostics, valid_config())
    start_supervised!(Buffer)
    start_supervised!({Exporter, config: valid_config(), interval_ms: 1_000})

    response = request_health()

    assert response.status == 200
    assert %{"status" => "healthy"} = JSON.decode!(response.resp_body)
  end

  defp request_health do
    :get
    |> conn("/diagnostics/healthz")
    |> Router.call([])
  end

  defp valid_config do
    %{
      mode: :localhost,
      base_url: "http://127.0.0.1:4000",
      allowed_hosts: ["127.0.0.1"],
      token: String.duplicate("x", 16),
      instance_id: "diagnostics-health-test-instance",
      generation: 1,
      connect_timeout_ms: 100,
      request_timeout_ms: 100,
      max_request_bytes: 32 * 1_024
    }
  end
end
