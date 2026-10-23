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

  test "stdout retains lifecycle fields even without a metadata formatter" do
    previous = Application.get_env(:chalk_sync, :observability)
    previous_level = Logger.level()
    Logger.configure(level: :info)
    Application.put_env(:chalk_sync, :observability, enabled: true)

    on_exit(fn ->
      Logger.configure(level: previous_level)
      Application.put_env(:chalk_sync, :observability, previous)
    end)

    log =
      ExUnit.CaptureLog.capture_log([level: :info], fn ->
        ChalkSync.Observability.root(nil, "sync.websocket.handshake", %{
          client_ip: "192.0.2.10",
          user_agent: "Chrome fixture",
          close_code: nil
        })
      end)

    assert log =~ ~s("client_ip":"192.0.2.10")
    assert log =~ ~s("user_agent":"Chrome fixture")
    assert log =~ ~s("close_code":null)
  end
end
