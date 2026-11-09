defmodule ChalkSync.Transport.DirectSyncTest do
  @moduledoc "Direct connections are bounded; connections without the proxy marker are not."
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.TestWSClient, as: Client
  alias ChalkSync.Transport.DirectLimits
  alias ChalkSync.Transport.SocketV1

  @marker [{"x-chalk-ingress", "direct"}, {"cf-connecting-ip", "203.0.113.7"}]

  defp restart_limiter(limits) do
    previous = Application.get_env(:chalk_sync, :direct_limits)
    Application.put_env(:chalk_sync, :direct_limits, limits)
    :ok = Supervisor.terminate_child(ChalkSync.Supervisor, DirectLimits)
    {:ok, _pid} = Supervisor.restart_child(ChalkSync.Supervisor, DirectLimits)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :direct_limits, previous),
        else: Application.delete_env(:chalk_sync, :direct_limits)

      Supervisor.terminate_child(ChalkSync.Supervisor, DirectLimits)
      Supervisor.restart_child(ChalkSync.Supervisor, DirectLimits)
    end)
  end

  test "a direct client over the upgrade rate gets 429 while Tunnel traffic is unaffected", ctx do
    restart_limiter(upgrades_per_ip_window: 2, window_ms: 60_000)

    for _attempt <- 1..2 do
      assert {:ok, client} = Client.connect(ctx.port, "/v1/sync", @marker)
      Client.close_tcp(client)
    end

    assert {:error, _conn, %{status_code: 429}} = Client.connect(ctx.port, "/v1/sync", @marker)

    for _attempt <- 1..4 do
      assert {:ok, client} = Client.connect(ctx.port, "/v1/sync", [])
      Client.close_tcp(client)
    end
  end

  test "a direct socket sending an oversized frame is closed with 1009", ctx do
    restart_limiter(max_frame_bytes: 4_096)
    assert {:ok, client} = Client.connect(ctx.port, "/v1/sync", @marker)

    client = Client.send_json(client, %{"type" => "hello", "pad" => String.duplicate("a", 8_192)})

    assert {:closed, 1009, _reason, _client} = Client.recv(client)
  end

  test "the same oversized frame on a Tunnel socket reaches protocol validation", ctx do
    restart_limiter(max_frame_bytes: 4_096)
    assert {:ok, client} = Client.connect(ctx.port, "/v1/sync", [])

    client = Client.send_json(client, %{"type" => "hello", "pad" => String.duplicate("a", 8_192)})

    # Sync's own frame limit answers with a protocol error frame; Bandit does not cut the socket.
    assert {:json, %{"type" => "error"}, _client} = Client.recv(client)
  end

  describe "socket process" do
    @tenant "11111111-1111-4111-8111-111111111111"

    defp hello(tenant_id) do
      token =
        DevTokenVerifier.token(%{
          "tenant_id" => tenant_id,
          "space_id" => "22222222-2222-4222-8222-222222222222",
          "episode_id" => "33333333-3333-4333-8333-333333333333",
          "participant_id" => "44444444-4444-4444-8444-444444444444",
          "participant_generation" => 1,
          "admission_lifecycle_intent_id" => "55555555-5555-4555-8555-555555555555",
          "role" => "owner",
          "capabilities" => Reducer.new("e").role_capabilities["owner"],
          "issued_at" => 1,
          "expires_at" => 4_102_444_800
        })

      JSON.encode!(%{
        "type" => "hello",
        "protocol" => 1,
        "token" => token,
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })
    end

    test "a direct socket over its tenant bound is closed with 1013 at hello" do
      restart_limiter(max_sockets_per_tenant: 0)
      {:ok, state} = SocketV1.init(direct: %{ip: "203.0.113.7"})

      assert {:stop, :normal, {1013, "try again later"}, stopped} =
               SocketV1.handle_in({hello(@tenant), [opcode: :text]}, state)

      assert stopped.terminal == %{close_code: 1013, reason: :direct_limit}
    end

    test "a direct socket that loses the slot race is closed with 1013" do
      restart_limiter(max_sockets_per_ip: 0)
      {:ok, state} = SocketV1.init(direct: %{ip: "203.0.113.7"})

      assert_received :direct_denied

      assert {:stop, :normal, {1013, "try again later"}, _stopped} =
               SocketV1.handle_info(:direct_denied, state)
    end

    test "a direct socket that never says hello times out like any other socket" do
      restart_limiter([])
      {:ok, state} = SocketV1.init(direct: %{ip: "203.0.113.7"})

      assert {:stop, :normal, {1008, "hello timeout"}, _stopped} =
               SocketV1.handle_info(:hello_timeout, state)
    end
  end
end
