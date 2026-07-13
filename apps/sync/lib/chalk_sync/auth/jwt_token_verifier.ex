defmodule ChalkSync.Auth.JWTTokenVerifier do
  @moduledoc "Production Ed25519 verifier for API-issued participant tokens."

  @behaviour ChalkSync.Auth.TokenVerifier

  alias ChalkSync.Auth.Claims
  alias ChalkSync.UUID

  @clock_skew_seconds 30
  @maximum_lifetime_seconds 300

  @impl true
  def verify(token) when is_binary(token) do
    with [encoded_header, encoded_claims, encoded_signature] <- String.split(token, "."),
         {:ok, header_json} <- decode_segment(encoded_header),
         :ok <- unique_header_fields(header_json),
         {:ok, header} <- JSON.decode(header_json),
         {:ok, public_key} <- public_key(header),
         {:ok, signature} <- Base.url_decode64(encoded_signature, padding: false),
         true <-
           :crypto.verify(
             :eddsa,
             :none,
             encoded_header <> "." <> encoded_claims,
             signature,
             [public_key, :ed25519]
           ),
         {:ok, claims_json} <- decode_segment(encoded_claims),
         {:ok, claims} <- JSON.decode(claims_json),
         {:ok, verified} <- verified_claims(claims) do
      {:ok, verified}
    else
      _ -> {:error, :invalid_token}
    end
  end

  def verify(_token), do: {:error, :invalid_token}

  defp decode_segment(segment), do: Base.url_decode64(segment, padding: false)

  defp unique_header_fields(json) do
    if field_count(json, "alg") == 1 and field_count(json, "kid") == 1 and
         field_count(json, "crit") == 0 do
      :ok
    else
      {:error, :invalid_header}
    end
  end

  defp field_count(json, field) do
    Regex.scan(~r/"#{field}"\s*:/u, json) |> length()
  end

  defp public_key(%{"alg" => "EdDSA", "kid" => kid, "typ" => "JWT"})
       when is_binary(kid) do
    Application.fetch_env!(:chalk_sync, :token_public_keys)
    |> Map.fetch(kid)
  end

  defp public_key(_header), do: {:error, :invalid_header}

  defp verified_claims(claims) when is_map(claims) do
    now = Application.get_env(:chalk_sync, :token_clock, fn -> System.system_time(:second) end).()
    issuer = Application.fetch_env!(:chalk_sync, :token_issuer)
    audience = Application.fetch_env!(:chalk_sync, :token_audience)

    with %{
           "iss" => ^issuer,
           "aud" => ^audience,
           "sub" => subject,
           "jti" => jti,
           "iat" => issued_at,
           "nbf" => not_before,
           "exp" => expires_at,
           "tenant_id" => tenant_id,
           "room_id" => room_id,
           "session_id" => session_id,
           "participant_id" => participant_id,
           "participant_session_id" => participant_session_id,
           "participant_session_generation" => generation,
           "admission_lifecycle_intent_id" => intent_id,
           "display_name" => display_name
         } <- claims,
         true <-
           valid_strings?([
             subject,
             jti,
             tenant_id,
             room_id,
             session_id,
             participant_id,
             intent_id,
             display_name
           ]),
         true <- valid_uuids?([tenant_id, room_id, session_id, participant_id, intent_id]),
         true <- participant_session_id == subject,
         true <- participant_id == subject,
         true <- is_integer(generation) and generation > 0,
         true <- byte_size(display_name) <= 256,
         {:ok, authorization} <- authorization_envelope(claims),
         true <- valid_times?(issued_at, not_before, expires_at, now) do
      {:ok,
       %Claims{
         tenant_id: tenant_id,
         room_id: room_id,
         participant_id: participant_id,
         session_id: session_id,
         participant_session_id: subject,
         participant_session_generation: generation,
         admission_lifecycle_intent_id: intent_id,
         issued_at: issued_at,
         expires_at: expires_at,
         display_name: display_name,
         initial_role: authorization.initial_role,
         eligible_roles: authorization.eligible_roles,
         capabilities: authorization.capabilities
       }}
    else
      _ -> {:error, :invalid_claims}
    end
  end

  defp verified_claims(_claims), do: {:error, :invalid_claims}

  defp valid_strings?(values), do: Enum.all?(values, &(is_binary(&1) and byte_size(&1) > 0))

  defp valid_uuids?(values), do: Enum.all?(values, &match?({:ok, _uuid}, UUID.dump(&1)))

  defp valid_capabilities?(capabilities) do
    is_list(capabilities) and length(capabilities) <= 32 and
      Enum.all?(capabilities, &(is_binary(&1) and byte_size(&1) in 1..64))
  end

  defp authorization_envelope(claims) do
    role_claims? = Map.has_key?(claims, "initial_role") or Map.has_key?(claims, "eligible_roles")
    capabilities? = Map.has_key?(claims, "capabilities")

    cond do
      capabilities? and not role_claims? ->
        capabilities = claims["capabilities"]

        if valid_capabilities?(capabilities),
          do: {:ok, %{initial_role: nil, eligible_roles: [], capabilities: capabilities}},
          else: {:error, :invalid_capabilities}

      not capabilities? and role_claims? ->
        initial_role = claims["initial_role"]
        eligible_roles = claims["eligible_roles"]

        if Claims.valid_role_envelope?(initial_role, eligible_roles),
          do:
            {:ok, %{initial_role: initial_role, eligible_roles: eligible_roles, capabilities: []}},
          else: {:error, :invalid_role_envelope}

      true ->
        {:error, :invalid_authorization_envelope}
    end
  end

  defp valid_times?(issued_at, not_before, expires_at, now) do
    Enum.all?([issued_at, not_before, expires_at], &is_integer/1) and
      issued_at <= now + @clock_skew_seconds and
      not_before <= now + @clock_skew_seconds and
      expires_at > now - @clock_skew_seconds and
      expires_at - issued_at <= @maximum_lifetime_seconds
  end
end
