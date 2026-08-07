defmodule ChalkSync.Diagnostics.ServiceCredential do
  @moduledoc """
  Short-lived Ed25519 credential for hosted Sync diagnostic intake.

  The private signing seed is deliberately omitted from inspection. Tokens are
  minted per append so the exporter never retains an expired bearer credential.
  """

  @derive {Inspect, except: [:private_seed, :clock]}
  @enforce_keys [
    :issuer,
    :key_id,
    :private_seed,
    :environment,
    :instance_id,
    :generation,
    :clock
  ]
  defstruct @enforce_keys

  @audience "chalk-diagnostics-service"
  @capability "append"
  @producer_id "sync"
  @source "sync"
  @lifetime_seconds 300
  @maximum_generation 2_147_483_648
  @safe_identifier ~r/\A[A-Za-z0-9][A-Za-z0-9._:@+\/=\-]{0,127}\z/

  @opaque t :: %__MODULE__{
            issuer: binary(),
            key_id: binary(),
            private_seed: binary(),
            environment: binary(),
            instance_id: binary(),
            generation: pos_integer(),
            clock: (-> integer())
          }

  @spec new(keyword()) :: {:ok, t()} | {:error, :invalid_config}
  def new(options) when is_list(options) do
    issuer = Keyword.get(options, :issuer)
    key_id = Keyword.get(options, :key_id)
    private_key = Keyword.get(options, :private_key)
    environment = Keyword.get(options, :environment)
    instance_id = Keyword.get(options, :instance_id)
    generation = Keyword.get(options, :generation)
    clock = Keyword.get(options, :clock, fn -> System.system_time(:second) end)

    with true <- valid_issuer?(issuer),
         true <- safe_identifier?(key_id),
         {:ok, private_seed} <- private_seed(private_key),
         true <- environment in ["localhost", "development", "staging"],
         true <- safe_identifier?(instance_id),
         true <- is_integer(generation) and generation in 1..@maximum_generation,
         true <- is_function(clock, 0) do
      {:ok,
       %__MODULE__{
         issuer: issuer,
         key_id: key_id,
         private_seed: private_seed,
         environment: environment,
         instance_id: instance_id,
         generation: generation,
         clock: clock
       }}
    else
      _invalid -> {:error, :invalid_config}
    end
  end

  def new(_options), do: {:error, :invalid_config}

  @spec issue(t()) :: {:ok, binary()} | {:error, :credential_unavailable}
  def issue(%__MODULE__{} = credential) do
    issued_at = credential.clock.()

    with true <- is_integer(issued_at) and issued_at > 0,
         token_id <- Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false),
         {:ok, encoded_header} <- encode(header(credential)),
         {:ok, encoded_claims} <- encode(claims(credential, token_id, issued_at)),
         signing_input = encoded_header <> "." <> encoded_claims,
         signature when is_binary(signature) <-
           :crypto.sign(:eddsa, :none, signing_input, [credential.private_seed, :ed25519]) do
      {:ok, signing_input <> "." <> Base.url_encode64(signature, padding: false)}
    else
      _failure -> {:error, :credential_unavailable}
    end
  rescue
    _exception -> {:error, :credential_unavailable}
  end

  def issue(_credential), do: {:error, :credential_unavailable}

  @spec bound_to?(t(), binary(), binary(), integer()) :: boolean()
  def bound_to?(%__MODULE__{} = credential, producer_id, instance_id, generation) do
    producer_id == @producer_id and instance_id == credential.instance_id and
      generation == credential.generation
  end

  def bound_to?(_credential, _producer_id, _instance_id, _generation), do: false

  defp header(credential) do
    %{"alg" => "EdDSA", "kid" => credential.key_id, "typ" => "JWT"}
  end

  defp claims(credential, token_id, issued_at) do
    %{
      "aud" => @audience,
      "capability" => @capability,
      "environment" => credential.environment,
      "exp" => issued_at + @lifetime_seconds,
      "generation" => credential.generation,
      "iat" => issued_at,
      "instance_id" => credential.instance_id,
      "iss" => credential.issuer,
      "jti" => token_id,
      "nbf" => issued_at,
      "source" => @source,
      "sub" => @producer_id
    }
  end

  defp encode(value) do
    {:ok, value |> JSON.encode!() |> Base.url_encode64(padding: false)}
  rescue
    _exception -> {:error, :encoding_failed}
  end

  # API signing keys use Go's 64-byte Ed25519 private-key representation:
  # 32-byte seed followed by the derived 32-byte public key. Erlang's crypto
  # API signs from the seed, so verify the public half before retaining it.
  defp private_seed(<<seed::binary-size(32), public_key::binary-size(32)>>) do
    case :crypto.generate_key(:eddsa, :ed25519, seed) do
      {derived_public_key, ^seed} ->
        if :crypto.hash_equals(derived_public_key, public_key),
          do: {:ok, seed},
          else: {:error, :invalid_key}

      _invalid ->
        {:error, :invalid_key}
    end
  rescue
    _exception -> {:error, :invalid_key}
  end

  defp private_seed(_private_key), do: {:error, :invalid_key}

  defp valid_issuer?(issuer) do
    is_binary(issuer) and byte_size(issuer) in 1..512 and String.trim(issuer) == issuer and
      valid_issuer_uri?(URI.parse(issuer))
  end

  defp valid_issuer_uri?(%URI{
         scheme: "https",
         host: host,
         userinfo: nil,
         query: nil,
         fragment: nil
       }),
       do: is_binary(host) and host != ""

  defp valid_issuer_uri?(_uri), do: false

  defp safe_identifier?(value) do
    is_binary(value) and Regex.match?(@safe_identifier, value)
  end
end
