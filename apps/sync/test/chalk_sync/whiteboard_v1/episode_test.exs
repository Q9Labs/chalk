defmodule ChalkSync.WhiteboardV1.EpisodeTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Episode

  @scene_id "10000000-0000-4000-8000-000000000001"

  defmodule Repository do
    @behaviour ChalkSync.WhiteboardV1.Repository

    @impl true
    def connect(_identity) do
      {:ok,
       %{
         capabilities: ["drawWhiteboard"],
         participant_capabilities: ["drawWhiteboard"],
         scene_id: "10000000-0000-4000-8000-000000000001",
         revision: 7,
         can_draw: true,
         is_presenting: true
       }}
    end

    @impl true
    def set_presentation(_identity, operation) do
      {:ok,
       %{
         operation_id: operation.operation_id,
         outcome: :duplicate,
         scene_id: "10000000-0000-4000-8000-000000000001",
         revision: 7,
         presenting: false
       }}
    end

    @impl true
    def commit_update(_identity, _operation), do: {:error, :unavailable}

    @impl true
    def clear(_identity, _operation), do: {:error, :unavailable}

    @impl true
    def set_draw_permission(_identity, _operation), do: {:error, :unavailable}

    @impl true
    def snapshot(_identity), do: {:error, :unavailable}

    @impl true
    def read_after(_identity, scene_id, 7) do
      {:ok,
       [
         %{
           type: :presentation,
           operation_id: "whiteboard-presentation-0002",
           scene_id: scene_id,
           revision: 8,
           presenting: true
         }
       ]}
    end
  end

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

  test "welcomes with the current presentation and frames retry state from the repository" do
    identity = identity()

    assert {:ok, %{"presenting" => true}} = Episode.connect(identity)

    assert {:ok,
            %{
              "type" => "commit",
              "outcome" => "duplicate",
              "scene_id" => @scene_id,
              "revision" => "7"
            },
            %{
              "type" => "presentation_updated",
              "scene_id" => @scene_id,
              "revision" => "7",
              "presenting" => false
            }} =
             Episode.set_presentation(identity, %{
               operation_id: "whiteboard-presentation-0001",
               presenting: true
             })

    assert {:ok,
            [
              %{
                "type" => "presentation_updated",
                "scene_id" => @scene_id,
                "revision" => "8",
                "presenting" => true
              }
            ]} = Episode.read_after(identity, @scene_id, 7, true)

    assert {:ok, []} = Episode.read_after(identity, @scene_id, 7, false)
  end

  defp identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "30000000-0000-4000-8000-000000000003",
        space_id: "40000000-0000-4000-8000-000000000004",
        episode_id: "50000000-0000-4000-8000-000000000005"
      },
      participant_id: "20000000-0000-4000-8000-000000000002",
      participant_generation: 1
    }
  end
end
