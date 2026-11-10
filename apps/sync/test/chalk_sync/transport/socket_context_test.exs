defmodule ChalkSync.Transport.SocketContextTest do
  use ExUnit.Case, async: false
  alias ChalkSync.Transport.SocketContext

  test "request fields are bounded and do not retain URLs or credentials" do
    conn =
      Plug.Test.conn(:get, "/v1/sync?token=do-not-log")
      |> Plug.Conn.put_req_header("cf-connecting-ip", "not an IP")
      |> Plug.Conn.put_req_header("authorization", "Bearer do-not-log")
      |> Plug.Conn.put_req_header("user-agent", String.duplicate("a", 600))

    fields = SocketContext.request(conn)
    assert fields.client_ip == "127.0.0.1"
    assert String.length(fields.user_agent) == 512
    assert fields.close_code == nil
    refute inspect(fields) =~ "do-not-log"
  end

  for {label, agent, expected} <- [
        {"ASCII", "Chrome fixture", "Chrome fixture"},
        {"opaque FF", <<0xFF>>, nil},
        {"invalid C3 28", <<0xC3, 0x28>>, nil}
      ] do
    @agent agent
    @expected expected
    test "stdout retains handshake and close fields for #{label} User-Agent bytes" do
      previous = Application.get_env(:chalk_sync, :observability)
      previous_level = Logger.level()
      Logger.configure(level: :info)
      Application.put_env(:chalk_sync, :observability, enabled: true)

      on_exit(fn ->
        Logger.configure(level: previous_level)
        Application.put_env(:chalk_sync, :observability, previous)
      end)

      fields =
        Plug.Test.conn(:get, "/v1/sync")
        |> Plug.Conn.put_req_header("cf-connecting-ip", "192.0.2.10")
        |> Plug.Conn.put_req_header("user-agent", @agent)
        |> SocketContext.request()

      log =
        ExUnit.CaptureLog.capture_log([level: :info], fn ->
          ChalkSync.Observability.root(nil, "sync.websocket.handshake", fields)
          ChalkSync.Observability.root(nil, "sync.websocket.closed", %{fields | close_code: 1008})
        end)

      assert log =~ ~s("client_ip":"192.0.2.10")
      assert log =~ "sync.websocket.handshake"
      assert log =~ "sync.websocket.closed"
      assert log =~ ~s("user_agent":#{JSON.encode!(@expected)})
      assert log =~ ~s("close_code":null)
      assert log =~ ~s("close_code":1008)
    end
  end
end
