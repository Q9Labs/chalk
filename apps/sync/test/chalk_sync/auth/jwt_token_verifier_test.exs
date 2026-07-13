defmodule ChalkSync.Auth.JWTTokenVerifierTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Auth.JWTTokenVerifier

  @now 1_783_858_800

  setup do
    {public_key, private_key} = :crypto.generate_key(:eddsa, :ed25519)

    previous =
      for key <- [:token_public_keys, :token_issuer, :token_audience, :token_clock], into: %{} do
        {key, Application.get_env(:chalk_sync, key, :missing)}
      end

    Application.put_env(:chalk_sync, :token_public_keys, %{"launch-1" => public_key})
    Application.put_env(:chalk_sync, :token_issuer, "https://api.chalk.test")
    Application.put_env(:chalk_sync, :token_audience, "chalk-sync")
    Application.put_env(:chalk_sync, :token_clock, fn -> @now end)

    on_exit(fn ->
      Enum.each(previous, fn
        {key, :missing} -> Application.delete_env(:chalk_sync, key)
        {key, value} -> Application.put_env(:chalk_sync, key, value)
      end)
    end)

    %{private_key: private_key}
  end

  test "verifies an API-issued identity token", %{private_key: private_key} do
    token = token(private_key, claims())

    assert {:ok, verified} = JWTTokenVerifier.verify(token)
    assert verified.tenant_id == "11111111-1111-4111-8111-111111111111"
    assert verified.participant_session_generation == 1
    assert verified.capabilities == ["control:hand"]
  end

  test "verifies a v3 role envelope without authorizing capabilities", %{
    private_key: private_key
  } do
    claims =
      claims()
      |> Map.delete("capabilities")
      |> Map.merge(%{
        "initial_role" => "participant",
        "eligible_roles" => ["participant", "cohost"]
      })

    assert {:ok, verified} = private_key |> token(claims) |> JWTTokenVerifier.verify()
    assert verified.initial_role == "participant"
    assert verified.eligible_roles == ["participant", "cohost"]
    assert verified.capabilities == []
  end

  test "rejects mixed, unknown, duplicate, ineligible, and unsafe host role envelopes", %{
    private_key: private_key
  } do
    base = Map.delete(claims(), "capabilities")

    invalid = [
      Map.merge(base, %{
        "initial_role" => "owner",
        "eligible_roles" => ["owner"]
      }),
      Map.merge(base, %{
        "initial_role" => "participant",
        "eligible_roles" => ["participant", "participant"]
      }),
      Map.merge(base, %{
        "initial_role" => "cohost",
        "eligible_roles" => ["participant"]
      }),
      Map.merge(base, %{"initial_role" => "host", "eligible_roles" => ["host"]}),
      Map.merge(claims(), %{
        "initial_role" => "participant",
        "eligible_roles" => ["participant"]
      })
    ]

    Enum.each(invalid, fn candidate ->
      assert {:error, :invalid_token} =
               private_key |> token(candidate) |> JWTTokenVerifier.verify()
    end)
  end

  test "rejects an unsupported algorithm", %{private_key: private_key} do
    assert {:error, :invalid_token} =
             private_key
             |> token(claims(), %{"alg" => "none", "kid" => "launch-1", "typ" => "JWT"})
             |> JWTTokenVerifier.verify()
  end

  test "rejects duplicate key ids", %{private_key: private_key} do
    header = ~s({"alg":"EdDSA","kid":"launch-1","kid":"launch-1","typ":"JWT"})

    assert {:error, :invalid_token} =
             signed_token(private_key, header, claims()) |> JWTTokenVerifier.verify()
  end

  test "rejects an expired token", %{private_key: private_key} do
    assert {:error, :invalid_token} =
             private_key
             |> token(Map.put(claims(), "exp", @now - 31))
             |> JWTTokenVerifier.verify()
  end

  defp claims do
    participant = "44444444-4444-4444-8444-444444444444"

    %{
      "iss" => "https://api.chalk.test",
      "aud" => "chalk-sync",
      "sub" => participant,
      "jti" => "token-id",
      "iat" => @now,
      "nbf" => @now,
      "exp" => @now + 300,
      "tenant_id" => "11111111-1111-4111-8111-111111111111",
      "room_id" => "22222222-2222-4222-8222-222222222222",
      "session_id" => "33333333-3333-4333-8333-333333333333",
      "participant_id" => participant,
      "participant_session_id" => participant,
      "participant_session_generation" => 1,
      "admission_lifecycle_intent_id" => "55555555-5555-4555-8555-555555555555",
      "display_name" => "Ada",
      "capabilities" => ["control:hand"]
    }
  end

  defp token(
         private_key,
         claims,
         header \\ %{"alg" => "EdDSA", "kid" => "launch-1", "typ" => "JWT"}
       ) do
    signed_token(private_key, JSON.encode!(header), claims)
  end

  defp signed_token(private_key, header_json, claims) do
    encoded_header = Base.url_encode64(header_json, padding: false)
    encoded_claims = claims |> JSON.encode!() |> Base.url_encode64(padding: false)
    signing_input = encoded_header <> "." <> encoded_claims
    signature = :crypto.sign(:eddsa, :none, signing_input, [private_key, :ed25519])
    signing_input <> "." <> Base.url_encode64(signature, padding: false)
  end
end
