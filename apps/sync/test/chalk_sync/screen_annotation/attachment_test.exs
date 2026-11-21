defmodule ChalkSync.ScreenAnnotation.AttachmentTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.JWTTokenVerifier
  alias ChalkSync.ScreenAnnotation.Attachment
  alias ChalkSync.TestWSClient
  alias ChalkSync.UUID

  @issuer "https://api.chalk.test"
  @audience "screen_annotation_helper_v1"

  setup do
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

    %{issuer: issuer_secret, device: device_secret, claims: claims}
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
