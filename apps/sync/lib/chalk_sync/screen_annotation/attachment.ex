defmodule ChalkSync.ScreenAnnotation.Attachment do
  @moduledoc "Verifies the short-lived, key-bound credential for one sharer's annotation layer."

  alias ChalkSync.Auth.JWTTokenVerifier
  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema
  alias ChalkSync.Stateholder.{EpisodeKey, Identity}
  alias ChalkSync.UUID

  @metadata Schema.helper_attachment()
  @audience @metadata["audience"]
  @lease_seconds div(@metadata["leaseMs"], 1000)
  @proof_domain @metadata["proofDomain"]
  @commands @metadata["commands"]

  def nonce, do: :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)

  def verify(
        %{
          "type" => "annotation_helper_attach",
          "version" => 1,
          "ticket" => token,
          "proof" => proof
        } = frame,
        nonce
      )
      when map_size(frame) == 4 and is_binary(token) and byte_size(token) in 1..4096 and
             is_binary(proof) and byte_size(proof) == 86 do
    with {:ok, claims} <- JWTTokenVerifier.verify_signed_claims(token),
         {:ok, binding, key} <- ticket_binding(claims),
         {:ok, <<signature::binary-size(64)>>} <- Base.url_decode64(proof, padding: false),
         message = proof_message(nonce, token),
         true <- verify_proof(key, message, signature) do
      {:ok, binding}
    else
      _ -> {:error, :invalid_attachment}
    end
  end

  def verify(_frame, _nonce), do: {:error, :invalid_attachment}

  def proof_message(nonce, token) do
    digest = :crypto.hash(:sha256, token) |> Base.url_encode64(padding: false)
    Enum.join([@proof_domain, nonce, digest], "\n")
  end

  def allowed_command?(%{"kind" => kind}), do: kind in @commands

  def matches?(%{binding: binding}, attachment, now) do
    now < attachment.expires_at_ms and
      binding["layer_id"] == attachment.layer and
      binding["publication_id"] == attachment.publication and
      binding["sharer_id"] == attachment.identity.participant_id
  end

  def matches?(_layer, _attachment, _now), do: false

  defp ticket_binding(%{
         "iss" => issuer,
         "aud" => @audience,
         "sub" => participant,
         "role" => "sharer",
         "version" => 1,
         "tenant_id" => tenant,
         "space_id" => space,
         "episode_id" => episode,
         "participant_id" => participant,
         "participant_generation" => generation,
         "publication_id" => publication,
         "layer_id" => layer,
         "iat" => issued,
         "nbf" => starts,
         "exp" => expires,
         "cnf" => %{"jwk" => jwk}
       })
       when is_binary(publication) and byte_size(publication) in 1..512 and
              is_integer(generation) and generation > 0 do
    with expected_issuer when is_binary(expected_issuer) <-
           Application.get_env(:chalk_sync, :token_issuer),
         true <- issuer == expected_issuer,
         true <- live_ticket?(issued, starts, expires),
         true <- Enum.all?([tenant, space, episode, participant, layer], &valid_id?/1),
         {:ok, key} <- proof_key(jwk) do
      identity = %Identity{
        episode: %EpisodeKey{tenant_id: tenant, space_id: space, episode_id: episode},
        participant_id: participant,
        participant_generation: generation
      }

      {:ok,
       %{
         identity: identity,
         publication: publication,
         layer: layer,
         expires_at_ms: expires * 1_000
       }, key}
    else
      _ -> {:error, :invalid_attachment}
    end
  end

  defp ticket_binding(_claims), do: {:error, :invalid_attachment}

  defp proof_key(%{"kty" => "OKP", "crv" => "Ed25519", "x" => x}) do
    with {:ok, key} <- decode_coordinate(x), do: {:ok, {:ed25519, key}}
  end

  defp proof_key(%{"kty" => "EC", "crv" => "P-256", "x" => x, "y" => y}) do
    with {:ok, x} <- decode_coordinate(x),
         {:ok, y} <- decode_coordinate(y),
         do: {:ok, {:p256, <<4, x::binary, y::binary>>}}
  end

  defp proof_key(_), do: :error

  defp decode_coordinate(value) when is_binary(value) and byte_size(value) == 43 do
    case Base.url_decode64(value, padding: false) do
      {:ok, <<_::256>> = coordinate} -> {:ok, coordinate}
      _ -> :error
    end
  end

  defp decode_coordinate(_), do: :error

  defp verify_proof({:ed25519, key}, message, signature),
    do: :crypto.verify(:eddsa, :none, message, signature, [key, :ed25519])

  defp verify_proof({:p256, key}, message, <<r::256, s::256>>) do
    signature = :public_key.der_encode(:"ECDSA-Sig-Value", {:"ECDSA-Sig-Value", r, s})
    :crypto.verify(:ecdsa, :sha256, message, signature, [key, :secp256r1])
  end

  defp live_ticket?(issued, starts, expires)
       when is_integer(issued) and is_integer(starts) and is_integer(expires) do
    now = System.system_time(:second)
    starts <= now and issued <= now and now < expires and expires - issued <= @lease_seconds
  end

  defp live_ticket?(_issued, _starts, _expires), do: false

  defp valid_id?(value),
    do: match?({:ok, _}, UUID.dump(value)) and value == String.downcase(value)
end
