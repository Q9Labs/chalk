defmodule ChalkSync.ProviderBridge.BlockedHTTPPlug do
  @moduledoc false
  import Plug.Conn

  def init(options), do: options

  def call(connection, options) do
    send(Keyword.fetch!(options, :observer), {:bridge_request, connection.request_path, self()})
    if connection.request_path == "/blocked", do: receive(do: (:release -> :ok))
    send_resp(connection, 200, "ok")
  end
end

defmodule ChalkSync.ProviderBridge.ErlangHTTPTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ProviderBridge.Transport.ErlangHTTP

  test "an independent Episode request does not queue behind a busy keep-alive connection" do
    server =
      start_supervised!(
        {Bandit,
         plug: {ChalkSync.ProviderBridge.BlockedHTTPPlug, observer: self()},
         ip: {127, 0, 0, 1},
         port: 0}
      )

    {:ok, {_address, port}} = ThousandIsland.listener_info(server)

    request = fn path ->
      ErlangHTTP.request(:post, "http://127.0.0.1:#{port}/#{path}", [], "{}",
        timeout: 5_000,
        connect_timeout: 1_000
      )
    end

    # Populate the pool before blocking a request on this origin.
    assert {:ok, 200, _, "ok"} = request.("warm")
    assert_receive {:bridge_request, "/warm", _}
    blocked = Task.async(fn -> request.("blocked") end)
    assert_receive {:bridge_request, "/blocked", handler}, 1_000

    try do
      independent = Task.async(fn -> request.("independent") end)
      assert_receive {:bridge_request, "/independent", _}, 1_000
      assert {:ok, 200, _, "ok"} = Task.await(independent)
    after
      send(handler, :release)
    end

    assert {:ok, 200, _, "ok"} = Task.await(blocked)
  end
end
