defmodule ChalkSync.ObservabilitySessionTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1

  @session_id "3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c"
  @other_session_id "7c1d9e20-8a3b-4c5d-8e6f-0a1b2c3d4e5f"

  defmodule LogHandler do
    def log(event, %{config: %{owner: owner}}), do: send(owner, {:log_event, event})
  end

  describe "context from the baggage header" do
    test "finds session.id among other members and properties" do
      for baggage <- [
            "session.id=#{@session_id}",
            "userId=alice, session.id=#{@session_id};ttl=60 ,serverNode=DF28",
            " session.id = #{@session_id} "
          ] do
        assert %{session_id: @session_id} = Observability.context([{"baggage", baggage}])
      end
    end

    test "matches the header name case-insensitively and joins repeated headers" do
      headers = [{"Baggage", "userId=alice"}, {"BAGGAGE", "session.id=#{@session_id}"}]
      assert %{session_id: @session_id} = Observability.context(headers)
    end

    test "ignores a missing or invalid value instead of failing" do
      for baggage <- [
            "",
            "userId=alice",
            "session.id=",
            "session.id=not-a-uuid",
            "session.id=#{String.upcase(@session_id)}",
            "xsession.id=#{@session_id}",
            "session.id#{@session_id}",
            "session.id=#{@session_id}0"
          ] do
        assert %{session_id: nil} = Observability.context([{"baggage", baggage}])
      end

      assert Observability.context([{"user-agent", "x"}]) == nil
    end

    test "a later valid member is used after an invalid one" do
      baggage = "session.id=bad,session.id=#{@session_id}"
      assert %{session_id: @session_id} = Observability.context([{"baggage", baggage}])
    end
  end

  describe "context from the hello field" do
    test "reads the baggage field" do
      assert %{session_id: @session_id} =
               Observability.context(%{"baggage" => "session.id=#{@session_id}"})

      assert %{session_id: nil} = Observability.context(%{"baggage" => "session.id=nope"})
    end

    test "the upgrade header wins and the hello field fills a gap" do
      header = Observability.context([{"baggage", "session.id=#{@session_id}"}])
      hello = Observability.context(%{"baggage" => "session.id=#{@other_session_id}"})

      assert %{session_id: @session_id} = Observability.merge(header, hello)

      assert %{session_id: @other_session_id} =
               Observability.merge(Observability.merge(nil, nil), hello)

      assert %{session_id: @session_id} = Observability.merge(header, nil)
    end
  end

  describe "hello decoding" do
    @hello %{
      "type" => "hello",
      "protocol" => 1,
      "token" => "signed-token",
      "streams" => %{
        "control" => %{"cursor" => nil},
        "media" => %{"cursor" => nil},
        "presence" => %{"cursor" => nil},
        "requests" => %{"cursor" => nil}
      }
    }

    test "a valid baggage field reaches the correlation fields" do
      frame = Map.put(@hello, "baggage", "session.id=#{@session_id}")

      assert {:ok, {:hello, %{correlation: %{"baggage" => "session.id=" <> @session_id}}}} =
               ProtocolV1.decode(JSON.encode!(frame))
    end

    test "the generated contract rejects an invalid baggage field" do
      for baggage <- ["session.id=nope", "session.id=#{@session_id},a=b", 7] do
        assert {:error, :invalid_hello} =
                 GeneratedV1.decode_client_frame(Map.put(@hello, "baggage", baggage))
      end
    end

    test "the connection ignores an invalid baggage field and still decodes the hello" do
      for baggage <- ["session.id=nope", "session.id=#{@session_id},a=b", 7] do
        assert {:ok, {:hello, %{correlation: correlation}}} =
                 ProtocolV1.decode(JSON.encode!(Map.put(@hello, "baggage", baggage)))

        refute Map.has_key?(correlation, "baggage")
      end
    end

    test "baggage is accepted on hello only" do
      baggage = "session.id=#{@session_id}"

      assert {:error, _reason} =
               ProtocolV1.decode(JSON.encode!(%{"type" => "ping", "baggage" => baggage}))
    end
  end

  describe "observed session" do
    setup do
      previous = Application.get_env(:chalk_sync, :observability)
      previous_level = Logger.level()
      Logger.configure(level: :info)
      Application.put_env(:chalk_sync, :observability, enabled: true)

      on_exit(fn ->
        Logger.configure(level: previous_level)
        Application.put_env(:chalk_sync, :observability, previous)
      end)

      %{context: Observability.context([{"baggage", "session.id=#{@session_id}"}])}
    end

    test "span attributes carry session.id only when a session is known", %{context: context} do
      with_session = metadata(context)
      without_session = metadata(Observability.merge(nil, nil))

      assert Observability.span_attributes(with_session, %{})["session.id"] == @session_id
      refute Map.has_key?(Observability.span_attributes(without_session, %{}), "session.id")
    end

    test "telemetry events and stdout lifecycle lines carry the session", %{context: context} do
      handler = "session-telemetry-#{System.unique_integer([:positive])}"
      owner = self()

      :telemetry.attach(
        handler,
        [:chalk_sync, :observability, :event],
        fn _event, _measurements, metadata, _config -> send(owner, {:event, metadata}) end,
        nil
      )

      on_exit(fn -> :telemetry.detach(handler) end)

      log =
        ExUnit.CaptureLog.capture_log([level: :info], fn ->
          Observability.root(context, "sync.websocket.handshake", %{transport: "websocket"})
          Observability.root(nil, "sync.websocket.closed", %{transport: "websocket"})
        end)

      assert_receive {:event, %{event: "sync.websocket.handshake", session_id: @session_id}}
      assert_receive {:event, %{event: "sync.websocket.closed", session_id: nil}}
      assert log =~ ~s("session.id":"#{@session_id}")
    end

    test "log metadata carries session_id", %{context: context} do
      handler = :"session_log_handler_#{System.unique_integer([:positive])}"
      :ok = :logger.add_handler(handler, LogHandler, %{config: %{owner: self()}})
      on_exit(fn -> :logger.remove_handler(handler) end)

      Observability.phase(context, "sync.websocket.authenticated", %{})

      assert_receive {:log_event, %{meta: %{session_id: @session_id}}}
    end

    test "the connection process binds Logger metadata", %{context: context} do
      Observability.bind_logger(Observability.merge(nil, nil))
      assert Logger.metadata()[:session_id] == nil

      Observability.bind_logger(context)
      assert Logger.metadata()[:session_id] == @session_id
    end

    test "the session never reaches frames or durable work", %{context: context} do
      assert Observability.frame_fields(context) |> Map.keys() |> Enum.sort() == ["journey_id"]

      observed = Observability.observed_operation_context(context)
      refute inspect(observed) =~ @session_id
      refute inspect(Observability.persisted_context(context.journey_id, nil, nil)) =~ @session_id
    end
  end

  defp metadata(context) do
    %{
      event: "sync.test",
      stage: "phase",
      journey_id: context.journey_id,
      session_id: context.session_id
    }
  end
end
