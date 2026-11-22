defmodule ChalkSync.ScreenAnnotation.LayerHistoryTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.ScreenAnnotation.{Layer, Proof, Repository}

  import Proof, only: [bind_frame: 1, command: 3, draft: 0]

  setup %{host: host, connection: connection} do
    Proof.publish_screen(host, connection, &on_exit/1)
  end

  test "mark IDs remain reserved while another contributor can undo or redo them", ctx do
    %{host: host, participant: participant, publication: publication} = ctx
    assert {:ok, %{"layer_id" => layer}} = Repository.command(host, bind_frame(publication))

    grant = %{
      "kind" => "set_draw_permission",
      "participant_id" => participant.participant_id,
      "allow" => true
    }

    assert {:ok, _} = Repository.command(host, command(layer, 1, grant))
    assert {:ok, %{can_draw: true}, %{fence: fence}, _, _} = Repository.read(participant)
    draft = draft()
    mark_id = draft["mark_id"]
    commit = %{"kind" => "commit", "draft" => draft}

    assert {:ok, _} = Repository.command(host, command(layer, fence, commit))
    assert {:ok, _} = Repository.command(host, command(layer, fence, %{"kind" => "undo"}))

    assert {:error, "invalid_target"} =
             Repository.command(participant, command(layer, fence, commit))

    assert {:ok, _} = Repository.command(host, command(layer, fence, %{"kind" => "redo"}))

    erase = %{"kind" => "erase", "mark_id" => mark_id}
    assert {:ok, _} = Repository.command(host, command(layer, fence, erase))

    assert {:error, "invalid_target"} =
             Repository.command(participant, command(layer, fence, commit))

    clear = %{"kind" => "clear", "scope" => %{"kind" => "mine"}}
    assert {:ok, _} = Repository.command(host, command(layer, fence, clear))
    assert {:ok, _} = Repository.command(participant, command(layer, fence + 1, commit))
    assert {:ok, _} = Repository.command(host, command(layer, fence + 1, %{"kind" => "undo"}))
    participant_id = participant.participant_id

    assert {:ok, _,
            %{marks: %{^mark_id => %{"author" => %{"participant_id" => ^participant_id}}}}, _, _} =
             Repository.read(host)
  end

  test "legacy history never replaces or removes a different mark with the same ID", ctx do
    assert {:ok, _} = Repository.command(ctx.host, bind_frame(ctx.publication))
    assert {:ok, actor, layer, now, _} = Repository.read(ctx.host)
    draft = draft()
    mark_id = draft["mark_id"]

    assert {:ok, original} =
             Layer.apply(layer, %{"kind" => "commit", "draft" => draft}, actor, now)

    assert {:ok, undone} = Layer.apply(original, %{"kind" => "undo"}, actor, now)

    # Simulate a layer persisted before the mark ID reservation rule.
    other = %{
      original.marks[mark_id]
      | "author" => Layer.contributor(ctx.participant.participant_id, "Guest")
    }

    other = %{other | "created_revision" => undone.revision + 1}
    collision = %{undone | marks: %{mark_id => other}, revision: undone.revision + 1}

    assert {:ok, %{marks: %{^mark_id => ^other}}} =
             Layer.apply(collision, %{"kind" => "redo"}, actor, now)

    collision = %{collision | history: original.history}

    assert {:ok, %{marks: %{^mark_id => ^other}}} =
             Layer.apply(collision, %{"kind" => "undo"}, actor, now)
  end

  test "clear mine does not fence another contributor when there is nothing to clear", ctx do
    %{host: host, participant: participant, publication: publication} = ctx
    assert {:ok, %{"layer_id" => layer}} = Repository.command(host, bind_frame(publication))
    policy = %{"kind" => "set_policy", "policy" => "hosts"}
    assert {:ok, _} = Repository.command(host, command(layer, 1, policy))

    assert {:ok, %{can_draw: false}, %{fence: fence, revision: revision}, _, _} =
             Repository.read(participant)

    clear = %{"kind" => "clear", "scope" => %{"kind" => "mine"}}

    assert {:ok, %{"revision" => ^revision}} =
             Repository.command(participant, command(layer, fence, clear))

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, fence, %{"kind" => "commit", "draft" => draft()})
             )

    assert {:ok, _, %{fence: ^fence}, _, _} = Repository.read(host)
  end
end
