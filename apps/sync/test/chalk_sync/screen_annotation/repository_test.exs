defmodule ChalkSync.ScreenAnnotation.RepositoryTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Observability
  alias ChalkSync.ProtocolV1
  alias ChalkSync.ScreenAnnotation.{Proof, Repository}
  alias ChalkSync.Stateholder.Postgres.ScreenShareLease
  alias ChalkSync.UUID

  setup %{host: host, connection: connection} do
    {:ok, _lease} =
      ScreenShareLease.acquire(
        connection,
        host.episode,
        host.participant_id,
        host.participant_generation
      )

    publication = publication(host.participant_generation, "screen-1")
    observe(connection, host, 1, publication)

    on_exit(fn ->
      params = [uuid(host.episode.tenant_id), uuid(host.episode.episode_id)]

      Postgrex.query!(
        connection,
        "delete from sync_screen_annotation_layers where tenant_id = $1 and episode_id = $2",
        params
      )

      Proof.cleanup_journey(connection, host.episode.episode_id)

      Postgrex.query!(
        connection,
        "delete from provider_operation_observations where tenant_id = $1 and episode_id = $2",
        params
      )

      Postgrex.query!(
        connection,
        "delete from provider_operation_observation_heads where tenant_id = $1 and episode_id = $2",
        params
      )
    end)

    %{publication: publication}
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

  defp observe(connection, host, sequence, publication) do
    params = [uuid(host.episode.tenant_id), uuid(host.episode.episode_id), sequence]

    publications = [
      %{
        "participant_id" => host.participant_id,
        "source" => "screen",
        "enabled" => true,
        "publication_id" => publication
      }
    ]

    assert {:ok, _} =
             Postgrex.transaction(connection, fn tx ->
               Postgrex.query!(
                 tx,
                 """
                 insert into provider_operation_observation_heads (tenant_id, episode_id, incarnation, sequence)
                 values ($1, $2, 1, $3) on conflict (tenant_id, episode_id) do update set sequence = excluded.sequence
                 """,
                 params
               )

               Postgrex.query!(
                 tx,
                 """
                 insert into provider_operation_observations
                   (tenant_id, episode_id, incarnation, sequence, publications, observation_fingerprint)
                 values ($1, $2, 1, $3, $4, decode(repeat('00', 32), 'hex'))
                 """,
                 params ++ [publications]
               )
             end)
  end

  defp publication(generation, track) do
    "chalk_pub_v1." <>
      Base.url_encode64(
        JSON.encode!(%{"c" => "session", "t" => track, "g" => generation, "m" => "1"}),
        padding: false
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

  defp operation_id(ms) do
    <<entropy::74, _::6>> = :crypto.strong_rand_bytes(10)
    <<a::12, b::62>> = <<entropy::74>>
    UUID.load!(<<ms::48, 7::4, a::12, 2::2, b::62>>)
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
