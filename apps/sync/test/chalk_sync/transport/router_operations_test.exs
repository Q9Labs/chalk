defmodule ChalkSync.Transport.RouterOperationsTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Transport.Router

  test "v1 is absent when compatibility routing is disabled" do
    previous = Application.fetch_env!(:chalk_sync, :enable_v1)
    Application.put_env(:chalk_sync, :enable_v1, false)
    on_exit(fn -> Application.put_env(:chalk_sync, :enable_v1, previous) end)

    conn = Plug.Test.conn(:get, "/v1/sync")
    conn = Router.call(conn, [])

    assert conn.status == 404
    assert JSON.decode!(conn.resp_body) == %{"error" => "not_found"}
  end
end
