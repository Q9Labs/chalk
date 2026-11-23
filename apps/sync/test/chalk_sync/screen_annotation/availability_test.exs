defmodule ChalkSync.ScreenAnnotation.AvailabilityTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.ScreenAnnotation.{Availability, Proof}
  alias ChalkSync.TestWSClient, as: Client

  test "withdraws the live layer and refuses old client commands without ending the share", ctx do
    %{connection: db, host: host, participant: viewer} = ctx

    server =
      start_supervised!({Bandit, plug: ChalkSync.Transport.Router, ip: {127, 0, 0, 1}, port: 0})

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    start_supervised!(Availability)
    on_exit(fn -> Proof.clear_availability(db) end)
    Proof.set_availability(db, true)
    Proof.set_availability(db, false)

    %{publication: publication} = Proof.publish_screen(host, db, &on_exit/1)
    bind = Proof.bind_frame(publication)
    {welcome, disabled} = connect(port, host)
    refute Map.has_key?(welcome, "screen_annotation")
    disabled = rejected(disabled, bind)
    Client.close_tcp(disabled)

    Proof.set_availability(db, true)
    {%{"screen_annotation" => true}, sharer} = connect(port, host)

    {%{"screen_annotation" => true, "screen_annotation_burn_in" => true}, observer} =
      connect(port, viewer, "?screen_annotation=1&screen_annotation_burn_in=1")

    {layer, sharer} = draw(sharer, bind)

    {%{"state" => %{"layer" => %{"layer_id" => ^layer}, "marks" => [_]}}, observer} =
      observer
      |> Client.send_json(%{"type" => "annotation_state_request"})
      |> receive_frame("annotation_state", &match?(%{"state" => %{"marks" => [_]}}, &1))

    Proof.set_availability(db, false)
    {_, sharer} = receive_frame(sharer, "annotation_state", &match?(%{"state" => nil}, &1))

    {%{"enabled" => false}, observer} =
      receive_frame(observer, "annotation_state", &match?(%{"state" => nil}, &1))

    sharer = rejected(sharer, Proof.command(layer, 1, %{"kind" => "pause", "paused" => true}))
    observer = Client.send_json(observer, %{"type" => "ping"})
    {_, observer} = receive_frame(observer, "pong")

    Proof.set_availability(db, true)

    # The share kept the same publication witness. The denied pause did not mutate it.
    {%{"state" => %{"layer" => %{"layer_id" => ^layer}, "paused" => false, "marks" => [_]}},
     observer} =
      receive_frame(observer, "annotation_state")

    Client.close_tcp(observer)
    Client.close_tcp(sharer)
  end

  defp connect(port, identity, query \\ "?screen_annotation=1") do
    {:ok, client} = Client.connect(port, "/v1/sync" <> query)

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    {welcome, client} = receive_frame(client, "welcome")

    {_, client} =
      client |> Client.acknowledge_recovery(welcome) |> receive_frame("recovery_complete")

    {welcome, client}
  end

  defp token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end

  defp draw(sharer, bind) do
    {%{"result" => %{"kind" => "accepted", "layer_id" => layer}}, sharer} =
      sharer |> Client.send_json(bind) |> receive_frame("annotation_receipt")

    mark = Proof.command(layer, 1, %{"kind" => "commit", "draft" => Proof.draft()})

    {%{"result" => %{"kind" => "accepted"}}, sharer} =
      sharer |> Client.send_json(mark) |> receive_frame("annotation_receipt")

    {layer, sharer}
  end

  defp rejected(client, %{"operation_id" => id} = command) do
    {%{"operation_id" => ^id, "result" => %{"kind" => "rejected", "reason" => "not_active"}},
     client} =
      client |> Client.send_json(command) |> receive_frame("annotation_receipt")

    client
  end

  defp receive_frame(client, type, matches? \\ fn _ -> true end) do
    case Client.recv(client, 3_000) do
      {:json, %{"type" => ^type} = frame, client} ->
        if matches?.(frame), do: {frame, client}, else: receive_frame(client, type, matches?)

      {:json, %{"type" => _}, client} ->
        receive_frame(client, type, matches?)

      other ->
        flunk("waiting for #{type}: #{inspect(other)}")
    end
  end
end
