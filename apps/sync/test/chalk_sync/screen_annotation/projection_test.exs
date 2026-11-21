defmodule ChalkSync.ScreenAnnotation.ProjectionTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.ScreenAnnotation.{Fanout, Presence, Proof, Repository}
  alias ChalkSync.SyncPostgres
  alias ChalkSync.Transport.Socket.Annotation
  alias ChalkSync.UUID

  import Proof, only: [bind_frame: 1, command: 3, draft: 0]

  setup %{host: host, connection: connection} do
    Proof.publish_screen(host, connection, &on_exit/1)
  end

  test "state requests coalesce without stranding a waiting replica", ctx do
    assert {:ok, _} = Repository.command(ctx.host, bind_frame(ctx.publication))
    state = projection(ctx.participant)
    request = %{"type" => "annotation_state_request"}

    assert {:push, [{:text, first}], state} = Annotation.handle(request, Annotation.enter(state))
    assert %{"type" => "annotation_state", "state" => %{"revision" => 1}} = JSON.decode!(first)

    state =
      Enum.reduce(1..25, state, fn _, state ->
        assert {:ok, state} = Annotation.handle(request, state)
        state
      end)

    assert_receive :annotation_tick, 1_200
    assert {:push, [{:text, followup}], state} = await_snapshot_tick(state)
    assert %{"type" => "annotation_state", "state" => %{"revision" => 1}} = JSON.decode!(followup)
    assert {:ok, _} = Annotation.changed(state)
  end

  test "the exact next projection never serializes faded ink", ctx do
    assert {:ok, %{"layer_id" => layer}} =
             Repository.command(ctx.host, bind_frame(ctx.publication))

    assert {:push, _, state} = Annotation.changed(projection(ctx.host))
    fade = %{draft() | "lifetime" => "fade"}

    assert {:ok, _} =
             Repository.command(
               ctx.host,
               command(layer, 1, %{"kind" => "commit", "draft" => fade})
             )

    Postgrex.query!(
      ctx.connection,
      """
      update sync_screen_annotation_layers
      set marks = jsonb_set(marks, $2::text[], '1'),
          last_change = jsonb_set(last_change, '{mark,expires_at_ms}', '1')
      where layer_id = $1
      """,
      [uuid(layer), [fade["mark_id"], "expires_at_ms"]]
    )

    assert {:push, [{:text, wire}], _} = Annotation.changed(state)

    assert %{"type" => "annotation_state", "state" => %{"revision" => 2, "marks" => []}} =
             JSON.decode!(wire)
  end

  test "listener reconnection retires pending presence and in-flight witness reads", ctx do
    start_supervised!({Fanout, url: SyncPostgres.database_url!(), source_id: UUID.generate()})
    listener = annotation_backend(ctx.connection)
    layer = UUID.generate()
    old_epoch = Presence.begin_refresh(ctx.host)
    now = System.system_time(:millisecond)
    witness = %{layer: layer, fence: 1, can_draw: true, until: now + 10_000}
    assert :ok = Presence.confirm(old_epoch, witness)

    frame = %{
      "layer_id" => layer,
      "fence" => 1,
      "author" => %{"participant_id" => ctx.host.participant_id},
      "server_at_ms" => now,
      "expires_at_ms" => now + 10_000,
      "cursor" => %{"point" => %{"x" => 1, "y" => 1}, "tool" => "pointer"},
      "draft" => nil
    }

    Presence.relay(ctx.host.episode, frame)
    assert_receive :annotation_presence_ready

    assert %{rows: [[true]]} =
             Postgrex.query!(ctx.connection, "select pg_terminate_backend($1)", [listener])

    assert annotation_backend(ctx.connection, listener) != listener
    assert [] = Presence.take()
    assert :dropped = Presence.publish(frame)
    assert :stale = Presence.confirm(old_epoch, witness)

    assert :ok = Presence.confirm(Presence.begin_refresh(ctx.host), witness)
    Presence.relay(ctx.host.episode, frame)
    assert [^frame] = Presence.take()
  end

  defp projection(identity),
    do: %{
      phase: :live,
      screen_annotation: true,
      identity: identity,
      annotation: nil,
      observability: nil
    }

  defp await_snapshot_tick(state) do
    case Annotation.tick(state) do
      {:ok, state} ->
        assert_receive :annotation_tick, 1_200
        Annotation.tick(state)

      result ->
        result
    end
  end

  defp annotation_backend(connection, old_pid \\ 0) do
    Enum.find_value(1..100, fn _ ->
      case Postgrex.query!(
             connection,
             """
             select pid from pg_stat_activity
             where state = 'idle' and query ilike '%listen %chalk_annotation_presence%'
               and pid <> $1
             """,
             [old_pid]
           ).rows do
        [[pid]] ->
          pid

        [] ->
          Process.sleep(20)
          nil
      end
    end) || flunk("annotation listener did not subscribe")
  end
end
