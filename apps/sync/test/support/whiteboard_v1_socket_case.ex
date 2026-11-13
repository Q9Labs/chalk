defmodule ChalkSync.WhiteboardV1.SocketCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.WhiteboardV1.SocketCase.Repository
  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Transport.SocketWhiteboardV1
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.ViewOwner

  @participant_id "20000000-0000-4000-8000-000000000002"
  @scene_id "10000000-0000-4000-8000-000000000001"

  using do
    quote do
      import ChalkSync.WhiteboardV1.SocketCase
      alias ChalkSync.WhiteboardV1.SocketCase.Repository
    end
  end

  def live_access_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        can_draw: false,
        scene_id: @scene_id,
        revision: 4
    }
  end

  def recovering_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})
    Process.cancel_timer(initial.hello_timer)

    live = %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        identity: identity(),
        scene_id: @scene_id,
        revision: 4
    }

    assert {:push, {:text, _first_page}, state} =
             receive_frame(
               %{"type" => "request_snapshot", "request_id" => "snapshot-request-0001"},
               live
             )

    assert state.phase == :recovering
    state
  end

  def receive_frame(
        %{"type" => "view"} = frame,
        %{view_owner: nil, identity: %Identity{} = identity} = state
      ) do
    {:ok, owner, _id, _snapshot} =
      ViewOwner.join(identity.episode, identity.participant_id)

    SocketWhiteboardV1.handle_in({JSON.encode!(frame), [opcode: :text]}, %{
      state
      | view_owner: owner
    })
  end

  def receive_frame(frame, state),
    do: SocketWhiteboardV1.handle_in({JSON.encode!(frame), [opcode: :text]}, state)

  def snapshot_ack(state),
    do: %{
      "type" => "snapshot_ack",
      "request_id" => state.snapshot.request_id,
      "scene_id" => state.snapshot.scene_id,
      "revision" => state.snapshot.revision,
      "page" => state.snapshot.acknowledged_page + 1
    }

  def element,
    do: %{
      "id" => "element-1",
      "type" => "rectangle",
      "version" => 1,
      "version_nonce" => 1,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{}
    }

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

  def access(episode_status, participant_status) do
    Application.put_env(
      :chalk_sync,
      :whiteboard_test_access,
      {:ok,
       %{status: episode_status, participants: %{{@participant_id, 1} => participant_status}}}
    )
  end

  # Starts the Episode's poller for this test process and waits for its first read. A poller of
  # another Episode that still runs from an earlier test also reports to this process, so the
  # messages name the Episode.
  def read(state) do
    episode = state.identity.episode
    Authority.watch(episode)
    assert_receive {:episode_access_read, ^episode}, 1_000

    wait_for(fn ->
      :ets.member(:whiteboard_authority_reads, EpisodeKey.authority_key(state.identity.episode))
    end)
  end

  def wait_for(condition, attempts \\ 100) do
    cond do
      condition.() -> :ok
      attempts == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_for(condition, attempts - 1)
    end
  end

  def new_episode(state), do: %{state.identity.episode | episode_id: UUID.generate()}

  def live_view_state do
    {:ok, initial} = SocketWhiteboardV1.init(%{})

    %{
      initial
      | phase: :live,
        connected_at: connected_earlier(),
        scene_id: @scene_id,
        revision: 4,
        display_name: "Ada",
        identity: %{identity() | capabilities: ["drawWhiteboard", "manageWhiteboard"]},
        extensions: extensions(view: :basic)
    }
  end

  def extensions(changes \\ []), do: struct!(Extensions.none(), changes)

  def view_frame(bring),
    do: %{
      "type" => "view",
      "x" => 10,
      "y" => 20,
      "width" => 800,
      "height" => 600,
      "bring" => bring
    }

  def update_event(revision) do
    %{
      type: :update,
      operation_id: "whiteboard-replay-000#{revision}",
      scene_id: @scene_id,
      revision: revision,
      elements: [element()]
    }
  end

  def token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => UUID.generate(),
      "display_name" => "Ada",
      "role" => "collaborator",
      "capabilities" => ["drawWhiteboard"],
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end

  def cursor, do: %{"type" => "cursor", "x" => 1, "y" => 2}

  def test_episode_id do
    case Process.get(:whiteboard_socket_episode_id) do
      nil ->
        episode_id = UUID.generate()
        Process.put(:whiteboard_socket_episode_id, episode_id)
        episode_id

      episode_id ->
        episode_id
    end
  end

  def identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: test_episode_id()
      },
      participant_id: @participant_id,
      participant_generation: 1
    }
  end

  # A socket whose connect check passed a second ago, before the reads the test waits for, so
  # those reads decide its access.
  def connected_earlier, do: System.monotonic_time(:millisecond) - 1_000
end
