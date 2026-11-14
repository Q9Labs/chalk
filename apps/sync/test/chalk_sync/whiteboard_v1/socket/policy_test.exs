defmodule ChalkSync.WhiteboardV1.SocketPolicyTest do
  use ChalkSync.WhiteboardV1.SocketCase, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.WhiteboardV1.Episode

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  test "reads drawing access again later, so a missed notification is repaired" do
    state = %{live_access_state() | extensions: extensions(draw_policy: true)}

    assert {:push, {:text, encoded}, read} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, state)

    assert %{"type" => "draw_access", "policy" => "hosts"} = JSON.decode!(encoded)
    assert Process.read_timer(read.access_timer) > 25_000

    assert {:ok, unchanged} = SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, read)
    refute Process.read_timer(read.access_timer)

    Process.put(
      :whiteboard_draw_access,
      {:ok,
       %{draw_policy: "everyone", can_draw: true, capabilities: ["drawWhiteboard"], grants: []}}
    )

    assert {:push, {:text, encoded}, _state} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, unchanged)

    assert %{"type" => "draw_access", "policy" => "everyone", "can_draw" => true} =
             JSON.decode!(encoded)
  end

  test "keeps one access retry however many changes arrive while Sync is unavailable" do
    Process.put(:whiteboard_draw_access, {:retryable, :storage_unavailable})

    assert {:ok, first} =
             SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, live_access_state())

    assert {:ok, second} = SocketWhiteboardV1.handle_info(:whiteboard_v1_access_changed, first)
    refute Process.read_timer(first.access_timer)
    assert Process.read_timer(second.access_timer) <= 1_000
  end

  test "rejects a policy change from a client that did not negotiate draw_policy_v1" do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4
    }

    frame = %{
      "type" => "set_draw_policy",
      "operation_id" => "whiteboard-policy-00001",
      "policy" => "hosts"
    }

    assert {:push, {:text, encoded}, _state} = receive_frame(frame, state)

    assert %{
             "type" => "operation_error",
             "operation" => "set_draw_policy",
             "code" => "unavailable"
           } =
             JSON.decode!(encoded)
  end

  test "names the policy cap when an Episode has used up its policy changes" do
    Process.put(:whiteboard_draw_policy_failure, {:error, :draw_policy_limit})
    state = %{live_access_state() | extensions: extensions(draw_policy: true)}

    frame = %{
      "type" => "set_draw_policy",
      "operation_id" => "whiteboard-policy-00001",
      "policy" => "hosts"
    }

    assert {:push, {:text, encoded}, _state} = receive_frame(frame, state)

    assert %{
             "type" => "operation_error",
             "operation" => "set_draw_policy",
             "code" => "rate_limited",
             "recoverable" => false,
             "message" => "This Episode has reached its limit of drawing policy changes"
           } = JSON.decode!(encoded)
  end

  test "stamps canonical views and strips owner fields for published clients" do
    live = live_view_state()
    assert {:ok, _} = receive_frame(view_frame(false), live)
    assert_received {:whiteboard_v1_frame, %{"owner_sequence" => 1} = frame}

    live = %{
      live
      | identity: %{live.identity | participant_id: "60000000-0000-4000-8000-000000000006"}
    }

    peer = %{live | extensions: extensions(view: :origins)}

    assert {:push, {:text, versioned}, _} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, peer)

    assert JSON.decode!(versioned)["origin_sequence"] == 1
    refute Map.has_key?(JSON.decode!(versioned), "owner_sequence")

    assert {:push, {:text, legacy}, _} =
             SocketWhiteboardV1.handle_info({:whiteboard_v1_frame, frame}, live)

    refute Map.has_key?(JSON.decode!(legacy), "origin_sequence")
    refute Map.has_key?(JSON.decode!(legacy), "owner_id")
  end

  test "does not echo a participant cursor or replay an applied update" do
    assert {:ok, initial} = SocketWhiteboardV1.init(%{})

    identity = %Identity{
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_id: @participant_id,
      participant_generation: 1
    }

    state = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity,
        scene_id: @scene_id,
        revision: 4
    }

    assert {:ok, ^state} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame,
                %{
                  "type" => "cursor",
                  "participant_id" => @participant_id,
                  "display_name" => "Ada",
                  "x" => 1,
                  "y" => 2,
                  "occurred_at" => "2026-07-29T12:00:00Z"
                }},
               state
             )

    assert {:ok, ^state} =
             SocketWhiteboardV1.handle_info(
               {:whiteboard_v1_frame,
                %{
                  "type" => "update",
                  "operation_id" => "operation-0000000001",
                  "scene_id" => @scene_id,
                  "revision" => "4",
                  "elements" => []
                }},
               state
             )
  end
end
