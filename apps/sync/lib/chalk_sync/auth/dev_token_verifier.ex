defmodule ChalkSync.Auth.DevTokenVerifier do
  @moduledoc """
  Dev/test-only verifier: decodes an UNSIGNED base64url JSON token and trusts
  it. Performs no signature verification — `config/runtime.exs` refuses to
  boot prod with this adapter.

  Token shape:

      base64url(JSON claims)
  """

  @behaviour ChalkSync.Auth.TokenVerifier

  alias ChalkSync.Auth.Claims

  @impl true
  def verify(token) when is_binary(token) do
    with {:ok, json} <- Base.url_decode64(token, padding: false),
         {:ok, %{} = claims} <- decode_json(json),
         %{"tenant_id" => tenant_id, "room_id" => room_id, "participant_id" => participant_id}
         when is_binary(tenant_id) and is_binary(room_id) and is_binary(participant_id) <-
           claims do
      {:ok,
       %Claims{
         tenant_id: tenant_id,
         room_id: room_id,
         participant_id: participant_id,
         session_id: Map.get(claims, "session_id"),
         participant_session_id: Map.get(claims, "participant_session_id"),
         participant_session_generation: Map.get(claims, "participant_session_generation"),
         admission_lifecycle_intent_id: Map.get(claims, "admission_lifecycle_intent_id"),
         issued_at: Map.get(claims, "issued_at"),
         expires_at: Map.get(claims, "expires_at"),
         display_name: Map.get(claims, "display_name", "Guest"),
         capabilities: Map.get(claims, "capabilities", [])
       }}
    else
      _ -> {:error, :invalid_token}
    end
  end

  def verify(_token), do: {:error, :invalid_token}

  @doc "Test/dev helper: builds a token accepted by `verify/1`."
  def token(claims) when is_map(claims) do
    claims |> JSON.encode!() |> Base.url_encode64(padding: false)
  end

  defp decode_json(json) do
    case JSON.decode(json) do
      {:ok, decoded} -> {:ok, decoded}
      {:error, _} -> {:error, :invalid_token}
    end
  end
end
