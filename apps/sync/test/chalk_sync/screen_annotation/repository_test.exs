defmodule ChalkSync.ScreenAnnotation.RepositoryTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1
  alias ChalkSync.ScreenAnnotation.{Housekeeping, Proof, Repository}
  alias ChalkSync.UUID
  import Proof, only: [observe: 4, operation_id: 1, publication: 2]

  setup %{host: host, connection: connection} do
    Proof.publish_screen(host, connection, &on_exit/1)
  end

  test "the active generation and video lease bind the layer, not client-asserted publication IDs",
       ctx do
    %{connection: connection, host: host, participant: participant, publication: publication} =
      ctx

    binding = bind_frame(publication)
    assert {:error, "invalid_target"} = Repository.command(participant, binding)

    assert {:error, "not_active"} =
             Repository.command(%{host | participant_generation: 2}, binding)

    assert {:error, "invalid_target"} =
             Repository.command(host, bind_frame(publication(1, "screen-audio")))

    trace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    context = Observability.context([{"traceparent", trace}])

    assert {:ok, %{"layer_id" => layer, "revision" => 1}} =
             Repository.command(host, binding, context)

    assert {:ok, %{"layer_id" => ^layer, "revision" => 1}} =
             Repository.command(host, bind_frame(publication))

    replacement = publication(1, "screen-2")
    observe(connection, host, 2, replacement)
    assert {:ok, _, nil, _, %{publication: ^replacement}} = Repository.read(host)

    assert {:error, "stale_layer"} =
             Repository.command(host, command(layer, 1, %{"kind" => "undo"}))

    assert {:ok, %{"layer_id" => next}} = Repository.command(host, bind_frame(replacement))
    refute next == layer
    Proof.assert_lifecycle_evidence(connection, host.episode.episode_id, layer)
  end

  test "baked mode survives retries and cannot cross a replacement publication", ctx do
    %{connection: connection, host: host, participant: viewer, publication: publication} = ctx
    baked = put_in(bind_frame(publication)["command"]["burned_in"], true)

    assert {:ok, {:screen_annotation, ^baked}} = ProtocolV1.decode(JSON.encode!(baked))

    assert {:error, :invalid_annotation_frame} =
             ProtocolV1.decode(JSON.encode!(put_in(baked["command"]["burned_in"], false)))

    assert {:error, "invalid_target"} = Repository.command(viewer, baked)
    assert {:ok, %{"layer_id" => layer}} = Repository.command(host, baked)
    assert {:ok, %{"layer_id" => ^layer}} = Repository.command(host, bind_frame(publication))

    assert {:ok, _, %{binding: %{"layer_id" => ^layer, "burned_in" => true}}, _, _} =
             Repository.read(viewer)

    replacement = publication(1, "app-only")
    observe(connection, host, 2, replacement)
    assert {:error, "invalid_target"} = Repository.command(host, baked)
    assert {:ok, %{"layer_id" => next}} = Repository.command(host, bind_frame(replacement))
    refute next == layer
    assert {:ok, _, %{binding: %{"layer_id" => ^next} = binding}, _, _} = Repository.read(viewer)
    refute Map.has_key?(binding, "burned_in")
  end

  test "draw grants are shared, and stale fences cannot restore cleared ink or claim a receipt",
       ctx do
    %{host: host, participant: participant, publication: publication} = ctx
    assert {:ok, %{"layer_id" => layer}} = Repository.command(host, bind_frame(publication))

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, 1, %{"kind" => "set_policy", "policy" => "picked"})
             )

    assert {:ok, _, %{fence: 2}, _, _} = Repository.read(participant)

    draft = draft()
    commit = %{"kind" => "commit", "draft" => draft}
    assert {:error, "forbidden"} = Repository.command(participant, command(layer, 2, commit))

    request = command(layer, 2, %{"kind" => "request_draw"})
    assert {:ok, _} = Repository.command(participant, request)

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, 2, %{
                 "kind" => "decide_draw",
                 "request_id" => request["operation_id"],
                 "allow" => true
               })
             )

    assert {:ok, %{can_draw: true}, %{fence: 3, requests: requests}, _, _} =
             Repository.read(participant)

    assert requests == %{}
    submitted = command(layer, 3, commit)
    assert {:ok, %{"revision" => committed}} = Repository.command(participant, submitted)

    assert {:error, "forbidden"} =
             Repository.command(host, command(layer, 3, %{"kind" => "request_draw"}))

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, 3, %{"kind" => "clear", "scope" => %{"kind" => "all"}})
             )

    assert {:ok, %{"revision" => ^committed}} = Repository.command(participant, submitted)

    assert {:error, "operation_id_conflict"} =
             Repository.command(
               participant,
               put_in(submitted["command"]["draft"]["color"], "#123456")
             )

    assert {:error, "stale_fence"} = Repository.command(participant, command(layer, 3, commit))
    assert {:ok, _} = Repository.command(participant, command(layer, 4, %{"kind" => "redo"}))
    assert {:ok, _, %{marks: marks}, _, _} = Repository.read(participant)
    assert marks == %{}
  end

  test "pause fences previews and finals while lifetimes and host authority remain independent",
       ctx do
    %{host: host, participant: participant, publication: publication} = ctx
    assert {:ok, %{"layer_id" => layer}} = Repository.command(host, bind_frame(publication))

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, 1, %{
                 "kind" => "set_draw_permission",
                 "participant_id" => participant.participant_id,
                 "allow" => true
               })
             )

    faded = Map.put(draft(), "lifetime", "fade")

    assert {:ok, _} =
             Repository.command(
               participant,
               command(layer, 2, %{"kind" => "commit", "draft" => faded})
             )

    assert {:ok, _} =
             Repository.command(host, command(layer, 2, %{"kind" => "pause", "paused" => true}))

    assert {:error, "paused"} =
             Repository.command(
               participant,
               command(layer, 3, %{"kind" => "commit", "draft" => draft()})
             )

    assert {:ok, _, %{paused: true, marks: marks}, _, _} = Repository.read(host)
    assert [%{"expires_at_ms" => expires, "committed_at_ms" => committed}] = Map.values(marks)
    assert expires - committed == 2_000

    assert {:ok, _} =
             Repository.command(
               participant,
               command(layer, 3, %{"kind" => "clear", "scope" => %{"kind" => "mine"}})
             )

    assert {:ok, _, %{marks: %{}}, _, _} = Repository.read(host)
  end

  test "elapsed ink, requests and receipts are pruned without a visible revision", ctx do
    %{connection: connection, host: host, publication: publication} = ctx
    assert {:ok, %{"layer_id" => layer}} = Repository.command(host, bind_frame(publication))
    expired = %{draft() | "lifetime" => "fade"}

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, 1, %{"kind" => "commit", "draft" => expired})
             )

    assert {:ok, _} =
             Repository.command(
               host,
               command(layer, 1, %{"kind" => "commit", "draft" => draft()})
             )

    id = [uuid(layer)]

    Postgrex.query!(
      connection,
      """
      update sync_screen_annotation_layers
      set marks = jsonb_set(marks, $2::text[], '1'), next_expiry_at_ms = 1,
          requests = '{"expired":{"expires_at_ms":1}}'
      where layer_id = $1
      """,
      id ++ [[expired["mark_id"], "expires_at_ms"]]
    )

    Postgrex.query!(
      connection,
      "update sync_screen_annotation_receipts set expires_at_ms = 1 where layer_id = $1",
      id
    )

    assert :ok = Housekeeping.sweep(connection)

    assert %{rows: [[3, 1, 1, %{}, nil]]} =
             Postgrex.query!(
               connection,
               """
               select revision, fence, (select count(*) from jsonb_object_keys(marks)), requests, next_expiry_at_ms
               from sync_screen_annotation_layers where layer_id = $1
               """,
               id
             )

    assert %{rows: [[0]]} =
             Postgrex.query!(
               connection,
               "select count(*) from sync_screen_annotation_receipts where layer_id = $1",
               id
             )
  end

  test "strict framing validates correlation, operation age and text bytes", ctx do
    bind = bind_frame(ctx.publication)

    assert {:ok, {:screen_annotation, ^bind}} =
             ProtocolV1.decode(JSON.encode!(Map.put(bind, "journey_id", UUID.generate())))

    assert {:error, :invalid_annotation_frame} =
             ProtocolV1.decode(JSON.encode!(Map.put(bind, "traceparent", "invalid")))

    assert {:error, :invalid_annotation_frame} =
             ProtocolV1.decode(JSON.encode!(Map.put(bind, "extra", false)))

    stale =
      Map.put(bind, "operation_id", operation_id(System.system_time(:millisecond) - 301_000))

    assert {:error, "invalid_target"} = Repository.command(ctx.host, stale)

    text = %{
      "kind" => "text",
      "at" => %{"x" => 1, "y" => 1},
      "text" => String.duplicate("é", 257),
      "note" => false
    }

    mark = Map.put(draft(), "shape", text)

    assert {:error, :invalid_annotation_frame} =
             ProtocolV1.decode(
               JSON.encode!(command(UUID.generate(), 1, %{"kind" => "commit", "draft" => mark}))
             )
  end

  defp bind_frame(publication),
    do:
      command(nil, nil, %{
        "kind" => "bind",
        "publication_id" => publication,
        "frame" => %{"width" => 1920, "height" => 1080}
      })

  defp command(layer, fence, command) do
    %{
      "type" => "annotation_command",
      "layer_id" => layer,
      "fence" => fence,
      "command" => command,
      "operation_id" => operation_id(System.system_time(:millisecond))
    }
  end

  defp draft do
    %{
      "mark_id" => UUID.generate(),
      "lifetime" => "keep",
      "color" => "#e55050",
      "width" => 128,
      "shape" => %{"kind" => "stamp", "at" => %{"x" => 1024, "y" => 1024}, "stamp" => "check"}
    }
  end
end
