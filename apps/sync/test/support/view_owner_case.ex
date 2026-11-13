defmodule ChalkSync.WhiteboardV1.ViewOwnerCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.ViewOwner

  using do
    quote do
      import ChalkSync.WhiteboardV1.ViewOwnerCase
    end
  end

  setup do
    episode = UUID.generate()
    person = UUID.generate()
    {:ok, owner, id, []} = ViewOwner.join(episode, person)
    %{episode: episode, person: person, owner: owner, id: id, stream: UUID.generate()}
  end

  def input(stream, sequence), do: %{input_id: "#{stream}:#{sequence}", move: true}

  def frame(person, x) do
    %{
      "type" => "view",
      "participant_id" => person,
      "display_name" => "Person",
      "x" => x,
      "y" => 0,
      "width" => 100,
      "height" => 100,
      "bring" => false,
      "occurred_at" => "2026-10-23T00:00:00.000Z"
    }
  end
end
