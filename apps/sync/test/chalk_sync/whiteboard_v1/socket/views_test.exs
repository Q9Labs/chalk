defmodule ChalkSync.WhiteboardV1.SocketViewsTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Fanout

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  test "shares views only over view_v1 and lets only board managers bring everyone" do
    host = %{identity() | capabilities: ["drawWhiteboard", "manageWhiteboard"]}
    guest = %{identity() | capabilities: ["drawWhiteboard"]}
    {:ok, initial} = SocketWhiteboardV1.init(%{})

    live = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        scene_id: @scene_id,
        revision: 4,
        display_name: "Ada"
    }

    Fanout.subscribe(host.episode)

    view = %{
      "type" => "view",
      "x" => 10,
      "y" => 20,
      "width" => 800,
      "height" => 600,
      "bring" => true
    }

    assert {:ok, _state} =
             receive_frame(view, %{live | identity: guest, extensions: extensions(view: :basic)})

    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}

    assert {:ok, _state} = receive_frame(view, %{live | identity: host, extensions: extensions()})
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}

    assert {:ok, _state} =
             receive_frame(view, %{live | identity: host, extensions: extensions(view: :basic)})

    assert_received {:whiteboard_v1_frame,
                     %{"type" => "view", "bring" => true, "width" => 800} = frame}

    other = %{live | identity: %{guest | participant_id: "60000000-0000-4000-8000-000000000006"}}
    assert {:ok, ^other} = SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, other)

    assert {:push, {:text, pushed}, _state} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, %{
               other
               | extensions: extensions(view: :basic)
             })

    assert JSON.decode!(pushed)["display_name"] == "Ada"
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "rechecks current management authority for bring after role changes" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)
    Process.put(:current_capabilities, ["drawWhiteboard"])
    assert {:ok, _} = receive_frame(view_frame(true), state)
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}
    Process.put(:current_capabilities, ["drawWhiteboard", "manageWhiteboard"])
    assert {:ok, _} = receive_frame(view_frame(true), state)
    assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "denied bring attempts still consume their rate-limit capacity" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)
    Process.put(:current_capabilities, ["drawWhiteboard"])
    assert {:ok, once} = receive_frame(view_frame(true), state)
    assert {:ok, twice} = receive_frame(view_frame(true), once)
    Process.put(:current_capabilities, ["drawWhiteboard", "manageWhiteboard"])
    assert {:ok, _} = receive_frame(view_frame(true), twice)
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "bring has bounded capacity independent of continuous cursor traffic" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)

    saturated = saturate_cursor_window(state)

    assert {:ok, brought} = receive_frame(view_frame(true), saturated)
    assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
    assert {:ok, limited} = receive_frame(view_frame(true), brought)
    assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
    assert {:ok, _} = receive_frame(view_frame(true), limited)
    refute_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => true}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  test "ordinary views have bounded capacity independent of continuous cursor traffic" do
    state = live_view_state()
    Fanout.subscribe(state.identity.episode)
    saturated = saturate_cursor_window(state)

    limited =
      Enum.reduce(1..10, saturated, fn _, state ->
        assert {:ok, next} =
                 receive_frame(
                   %{
                     view_frame(false)
                     | "x" =>
                         state.presence_windows[:view]
                         |> then(fn window -> if window, do: elem(window, 1), else: 0 end)
                   },
                   state
                 )

        assert_received {:whiteboard_v1_frame, %{"type" => "view", "bring" => false}}
        next
      end)

    assert {:ok, _} = receive_frame(view_frame(false), limited)
    refute_received {:whiteboard_v1_frame, %{"type" => "view"}}
  after
    Fanout.unsubscribe(identity().episode)
  end

  for {client, extensions, owner?, policy?, presenter?} <- [
        {"published 5.1.0",
         [%{"name" => "presentation_v1"}, %{"name" => "view_v1", "origins" => true}], false,
         false, false},
        {"current",
         [
           %{"name" => "presentation_v1"},
           %{"name" => "view_v1", "origins" => true, "owner" => true},
           %{"name" => "draw_policy_v1"}
         ], true, true, false},
        {"presenter-aware",
         [
           %{"name" => "presentation_v1", "presenter" => true},
           %{"name" => "view_v1", "origins" => true, "owner" => true},
           %{"name" => "draw_policy_v1"}
         ], true, true, true}
      ] do
    @hello_extensions extensions
    @hello_owner owner?
    @hello_policy policy?
    @hello_presenter presenter?
    test "negotiates Follow and drawing access for a #{client} hello" do
      {:ok, initial} = SocketWhiteboardV1.init(%{})
      identity = %{identity() | episode: %{identity().episode | episode_id: UUID.generate()}}

      assert {:push, {:text, wire}, live} =
               receive_frame(
                 %{
                   "type" => "hello",
                   "protocol" => "whiteboard-v1",
                   "token" => token(identity),
                   "cursor" => nil,
                   "extensions" => @hello_extensions
                 },
                 initial
               )

      welcome = JSON.decode!(wire)
      assert welcome["presenting"] == false
      assert Map.has_key?(welcome, "presenter_id") == @hello_presenter
      assert Map.has_key?(welcome, "view_owner_id") == @hello_owner

      assert live.extensions == %Extensions{
               presentation: if(@hello_presenter, do: :presenter, else: :basic),
               view: if(@hello_owner, do: :owner, else: :origins),
               draw_policy: @hello_policy
             }

      assert Process.alive?(live.view_owner)
      assert is_integer(live.connected_at)
      assert_received :whiteboard_v1_access_changed

      assert {:push, {:text, access_wire}, refreshed} =
               SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, live)

      access = JSON.decode!(access_wire)
      assert access["type"] == if(@hello_policy, do: "draw_access", else: "permission_updated")
      assert access["can_draw"] == false
      assert refreshed.can_draw == false
      assert Map.has_key?(access, "policy") == @hello_policy

      # The same refresh path continues working with an owner attached.
      Process.put(
        :whiteboard_draw_access,
        {:ok, %{draw_policy: "everyone", can_draw: true, capabilities: [], grants: []}}
      )

      assert {:push, {:text, changed_wire}, changed} =
               SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, refreshed)

      assert JSON.decode!(changed_wire)["can_draw"] == true
      assert changed.can_draw

      presentation = %{
        "type" => "presentation_updated",
        "scene_id" => changed.scene_id,
        "revision" => Integer.to_string(changed.revision + 1),
        "presenting" => true,
        "presenter_id" => @participant_id
      }

      assert {:push, {:text, presentation_wire}, _} =
               SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, presentation}, changed)

      decoded = JSON.decode!(presentation_wire)
      assert decoded["presenting"]
      assert Map.has_key?(decoded, "presenter_id") == @hello_presenter
    end
  end

  defp saturate_cursor_window(state) do
    Enum.reduce(1..60, state, fn _, state ->
      assert {:ok, next} = receive_frame(%{"type" => "cursor", "x" => 1, "y" => 2}, state)
      next
    end)
  end
end
