defmodule ChalkSync.ScreenAnnotation.AttachmentTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Auth.JWTTokenVerifier
  alias ChalkSync.ScreenAnnotation.{Attachment, Availability, Proof, Repository}
  alias ChalkSync.TestWSClient
  alias ChalkSync.UUID

  @issuer "https://api.chalk.test"
  @audience "screen_annotation_helper_v1"

  setup do
    server =
      start_supervised!({Bandit, plug: ChalkSync.Transport.Router, ip: {127, 0, 0, 1}, port: 0})

    {:ok, {_ip, port}} = ThousandIsland.listener_info(server)
    {issuer_key, issuer_secret} = :crypto.generate_key(:eddsa, :ed25519)
    {device_key, device_secret} = :crypto.generate_key(:eddsa, :ed25519)

    previous =
      for key <- [:token_public_keys, :token_issuer, :token_audience], into: %{} do
        {key, Application.fetch_env(:chalk_sync, key)}
      end

    Application.put_env(:chalk_sync, :token_public_keys, %{"issuer" => issuer_key})
    Application.put_env(:chalk_sync, :token_issuer, @issuer)
    Application.put_env(:chalk_sync, :token_audience, "chalk-sync")

    on_exit(fn ->
      Enum.each(previous, fn
        {key, :error} -> Application.delete_env(:chalk_sync, key)
        {key, {:ok, value}} -> Application.put_env(:chalk_sync, key, value)
      end)
    end)

    participant = UUID.generate()
    now = System.system_time(:second)

    claims = %{
      "iss" => @issuer,
      "aud" => @audience,
      "sub" => participant,
      "role" => "sharer",
      "version" => 1,
      "tenant_id" => UUID.generate(),
      "space_id" => UUID.generate(),
      "episode_id" => UUID.generate(),
      "participant_id" => participant,
      "participant_generation" => 1,
      "publication_id" => "screen-publication",
      "layer_id" => UUID.generate(),
      "iat" => now,
      "nbf" => now,
      "exp" => now + 60,
      "cnf" => %{"jwk" => %{"kty" => "OKP", "crv" => "Ed25519", "x" => encode(device_key)}}
    }

    %{issuer: issuer_secret, device: device_secret, claims: claims, port: port}
  end

  test "accepts only a timely sharer ticket with proof of the bound key on this socket", ctx do
    nonce = Attachment.nonce()
    token = token(ctx.issuer, ctx.claims)
    frame = attach(nonce, token, ctx.device)
    assert {:ok, binding} = Attachment.verify(frame, nonce)
    assert binding.identity.participant_id == ctx.claims["participant_id"]
    assert binding.identity.episode.tenant_id == ctx.claims["tenant_id"]
    assert binding.layer == ctx.claims["layer_id"]

    assert {:error, :invalid_attachment} = Attachment.verify(frame, Attachment.nonce())
    assert {:error, :invalid_token} = JWTTokenVerifier.verify(token)

    {_other_key, wrong_secret} = :crypto.generate_key(:eddsa, :ed25519)

    assert {:error, :invalid_attachment} =
             Attachment.verify(attach(nonce, token, wrong_secret), nonce)

    for overrides <- [
          %{"aud" => "chalk-sync"},
          %{"role" => "observer"},
          %{"exp" => ctx.claims["iat"]},
          %{"exp" => ctx.claims["iat"] + 61},
          %{"participant_generation" => 0}
        ] do
      altered = token(ctx.issuer, Map.merge(ctx.claims, overrides))

      assert {:error, :invalid_attachment} =
               Attachment.verify(attach(nonce, altered, ctx.device), nonce)
    end
  end

  test "a fixed-length P-256 device signature proves possession on only its own socket", ctx do
    nonce = Attachment.nonce()

    {<<4, x::binary-size(32), y::binary-size(32)>>, private} =
      :crypto.generate_key(:ecdh, :secp256r1)

    claims =
      put_in(ctx.claims, ["cnf", "jwk"], %{
        "kty" => "EC",
        "crv" => "P-256",
        "x" => encode(x),
        "y" => encode(y)
      })

    ticket = token(ctx.issuer, claims)

    message =
      "chalk.screen_annotation.helper.v1\n" <>
        nonce <> "\n" <> encode(:crypto.hash(:sha256, ticket))

    signature = :crypto.sign(:ecdsa, :sha256, message, [private, :secp256r1])
    {:"ECDSA-Sig-Value", r, s} = :public_key.der_decode(:"ECDSA-Sig-Value", signature)

    frame = %{
      "type" => "annotation_helper_attach",
      "version" => 1,
      "ticket" => ticket,
      "proof" => encode(<<r::256, s::256>>)
    }

    assert {:ok, _} = Attachment.verify(frame, nonce)
    assert {:error, :invalid_attachment} = Attachment.verify(frame, Attachment.nonce())
    wrong_proof = %{frame | "proof" => encode(<<r::256, 0::256>>)}
    assert {:error, :invalid_attachment} = Attachment.verify(wrong_proof, nonce)
  end

  test "cannot replay proof on a different actual WebSocket or enter as a participant", ctx do
    assert {:ok, first} = TestWSClient.connect(ctx.port, "/v1/screen-annotation/helper")
    assert {:ok, second} = TestWSClient.connect(ctx.port, "/v1/screen-annotation/helper")

    assert {:json, %{"type" => "annotation_helper_challenge", "nonce" => first_nonce}, first} =
             TestWSClient.recv(first)

    assert {:json, %{"type" => "annotation_helper_challenge", "nonce" => second_nonce}, second} =
             TestWSClient.recv(second)

    refute first_nonce == second_nonce
    wrong_socket = attach(first_nonce, token(ctx.issuer, ctx.claims), ctx.device)
    second = TestWSClient.send_json(second, wrong_socket)
    assert {:closed, 1008, "annotation attachment ended", _second} = TestWSClient.recv(second)

    first = TestWSClient.send_json(first, %{"type" => "hello", "protocol_version" => 1})

    assert {:closed, 1008, "annotation attachment ended", _first} = TestWSClient.recv(first)
  end

  test "a current sharer can pause over the attachment but cannot change shared draw policy",
       ctx do
    {socket, layer} = connect_attachment(ctx)

    socket =
      TestWSClient.send_json(socket, command(layer, 1, %{"kind" => "pause", "paused" => true}))

    assert {:json, %{"type" => "annotation_receipt", "result" => %{"kind" => "accepted"}}, socket} =
             TestWSClient.recv(socket)

    assert {:ok, _, %{paused: true, fence: 2}, _, _} = Repository.read(ctx.host)

    socket =
      TestWSClient.send_json(
        socket,
        command(layer, 2, %{"kind" => "set_policy", "policy" => "hosts"})
      )

    assert {:closed, 1008, "annotation attachment ended", _socket} = TestWSClient.recv(socket)
    assert {:ok, %{draw_policy: "everyone"}, _, _, _} = Repository.read(ctx.host)
  end

  test "an idle helper receives a fresh snapshot without asking for state", ctx do
    {socket, layer} = connect_attachment(ctx)

    assert {:json,
            %{"type" => "annotation_state", "state" => %{"layer" => %{"layer_id" => ^layer}}},
            _socket} = TestWSClient.recv(socket, 5_000)
  end

  test "an attachment already receives state and cannot request another snapshot", ctx do
    {socket, _layer} = connect_attachment(ctx)
    socket = TestWSClient.send_json(socket, %{"type" => "annotation_state_request"})
    assert {:closed, 1008, "annotation attachment ended", _socket} = TestWSClient.recv(socket)
  end

  test "an attachment cannot publish presence to the Episode", ctx do
    {socket, layer} = connect_attachment(ctx)

    socket =
      TestWSClient.send_json(socket, %{
        "type" => "annotation_presence",
        "layer_id" => layer,
        "fence" => 1,
        "cursor" => %{"point" => %{"x" => 1, "y" => 1}, "tool" => "pointer"},
        "draft" => nil
      })

    assert {:closed, 1008, "annotation attachment ended", _socket} = TestWSClient.recv(socket)
  end

  test "the runtime switch drops an attached Helper and refuses a new attachment", ctx do
    start_supervised!(Availability)
    on_exit(fn -> Proof.clear_availability(ctx.connection) end)
    Proof.set_availability(ctx.connection, true)
    {socket, _layer} = connect_attachment(ctx)

    assert {:ok, pending} = TestWSClient.connect(ctx.port, "/v1/screen-annotation/helper")

    assert {:json, %{"type" => "annotation_helper_challenge"}, pending} =
             TestWSClient.recv(pending)

    Proof.set_availability(ctx.connection, false)
    assert {:closed, 1008, "screen_annotation_disabled", _socket} = TestWSClient.recv(socket)
    pending = TestWSClient.send_json(pending, %{"type" => "annotation_helper_attach"})
    assert {:closed, 1008, "screen_annotation_disabled", _pending} = TestWSClient.recv(pending)

    assert {:ok, denied} = TestWSClient.connect(ctx.port, "/v1/screen-annotation/helper")
    assert {:closed, 1008, "screen_annotation_disabled", _denied} = TestWSClient.recv(denied)
  end

  defp connect_attachment(ctx) do
    %{publication: publication} = Proof.publish_screen(ctx.host, ctx.connection, &on_exit/1)

    bind = %{
      "kind" => "bind",
      "publication_id" => publication,
      "frame" => %{"width" => 1920, "height" => 1080}
    }

    assert {:ok, %{"layer_id" => layer}} = Repository.command(ctx.host, command(nil, nil, bind))

    claims =
      Map.merge(ctx.claims, %{
        "sub" => ctx.host.participant_id,
        "tenant_id" => ctx.host.episode.tenant_id,
        "space_id" => ctx.host.episode.space_id,
        "episode_id" => ctx.host.episode.episode_id,
        "participant_id" => ctx.host.participant_id,
        "publication_id" => publication,
        "layer_id" => layer
      })

    assert {:ok, socket} = TestWSClient.connect(ctx.port, "/v1/screen-annotation/helper")

    assert {:json, %{"type" => "annotation_helper_challenge", "nonce" => nonce}, socket} =
             TestWSClient.recv(socket)

    socket = TestWSClient.send_json(socket, attach(nonce, token(ctx.issuer, claims), ctx.device))

    assert {:json,
            %{"type" => "annotation_state", "state" => %{"layer" => %{"layer_id" => ^layer}}},
            socket} =
             TestWSClient.recv(socket)

    {socket, layer}
  end

  defp command(layer, fence, payload) do
    %{
      "type" => "annotation_command",
      "layer_id" => layer,
      "fence" => fence,
      "operation_id" => Proof.operation_id(System.system_time(:millisecond)),
      "command" => payload
    }
  end

  defp attach(nonce, ticket, secret) do
    # Independent encoding of the device's signed transcript.
    digest = encode(:crypto.hash(:sha256, ticket))
    proof = sign("chalk.screen_annotation.helper.v1\n" <> nonce <> "\n" <> digest, secret)
    %{"type" => "annotation_helper_attach", "version" => 1, "ticket" => ticket, "proof" => proof}
  end

  defp token(secret, claims) do
    header = encode(JSON.encode!(%{"typ" => "JWT", "alg" => "EdDSA", "kid" => "issuer"}))
    input = header <> "." <> encode(JSON.encode!(claims))
    input <> "." <> sign(input, secret)
  end

  defp sign(body, secret), do: encode(:crypto.sign(:eddsa, :none, body, [secret, :ed25519]))
  defp encode(value), do: Base.url_encode64(value, padding: false)
end
