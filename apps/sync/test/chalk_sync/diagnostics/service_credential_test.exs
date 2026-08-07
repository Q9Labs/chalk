defmodule ChalkSync.Diagnostics.ServiceCredentialTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Diagnostics.ServiceCredential

  @now 1_775_212_800

  test "issues a short-lived credential bound to the hosted Sync producer" do
    {credential, public_key, private_key} = credential_fixture()

    assert {:ok, first} = ServiceCredential.issue(credential)
    assert {:ok, second} = ServiceCredential.issue(credential)
    refute first == second

    assert [encoded_header, encoded_claims, encoded_signature] = String.split(first, ".")

    assert JSON.decode!(decode(encoded_header)) == %{
             "alg" => "EdDSA",
             "kid" => "diag-sync-1",
             "typ" => "JWT"
           }

    claims = JSON.decode!(decode(encoded_claims))

    assert claims == %{
             "aud" => "chalk-diagnostics-service",
             "capability" => "append",
             "environment" => "staging",
             "exp" => @now + 300,
             "generation" => 7,
             "iat" => @now,
             "instance_id" => "sync-instance-01",
             "iss" => "https://identity.example.test",
             "jti" => claims["jti"],
             "nbf" => @now,
             "source" => "sync",
             "sub" => "sync"
           }

    assert {:ok, token_id} = Base.url_decode64(claims["jti"], padding: false)
    assert byte_size(token_id) == 16
    assert {:ok, signature} = Base.url_decode64(encoded_signature, padding: false)

    assert :crypto.verify(
             :eddsa,
             :none,
             encoded_header <> "." <> encoded_claims,
             signature,
             [public_key, :ed25519]
           )

    inspected = inspect(credential)
    refute inspected =~ "private_seed"
    refute inspected =~ Base.url_encode64(private_key, padding: false)
    refute inspected =~ Base.url_encode64(binary_part(private_key, 0, 32), padding: false)
  end

  test "rejects malformed key material and producer identity bounds" do
    {public_key, private_seed} = :crypto.generate_key(:eddsa, :ed25519)
    private_key = private_seed <> public_key
    base = valid_options(private_key)

    assert {:error, :invalid_config} =
             ServiceCredential.new(Keyword.put(base, :private_key, private_seed))

    assert {:error, :invalid_config} =
             ServiceCredential.new(
               Keyword.put(base, :private_key, private_seed <> :binary.copy(<<0>>, 32))
             )

    assert {:error, :invalid_config} =
             ServiceCredential.new(Keyword.put(base, :instance_id, "sync instance"))

    assert {:error, :invalid_config} =
             ServiceCredential.new(Keyword.put(base, :issuer, "http://identity.example.test"))

    assert {:error, :invalid_config} =
             ServiceCredential.new(Keyword.put(base, :generation, 2_147_483_649))
  end

  test "fails closed when the signing clock is unavailable" do
    {credential, _public_key, _private_key} = credential_fixture(clock: fn -> :unavailable end)
    assert {:error, :credential_unavailable} = ServiceCredential.issue(credential)
  end

  defp credential_fixture(extra \\ []) do
    {public_key, private_seed} = :crypto.generate_key(:eddsa, :ed25519)
    private_key = private_seed <> public_key

    assert {:ok, credential} =
             private_key
             |> valid_options()
             |> Keyword.merge(extra)
             |> ServiceCredential.new()

    {credential, public_key, private_key}
  end

  defp valid_options(private_key) do
    [
      issuer: "https://identity.example.test",
      key_id: "diag-sync-1",
      private_key: private_key,
      environment: "staging",
      instance_id: "sync-instance-01",
      generation: 7,
      clock: fn -> @now end
    ]
  end

  defp decode(segment) do
    {:ok, decoded} = Base.url_decode64(segment, padding: false)
    decoded
  end
end
