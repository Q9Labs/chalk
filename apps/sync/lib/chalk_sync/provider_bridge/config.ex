defmodule ChalkSync.ProviderBridge.Config do
  @moduledoc false

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane

  # Cloudflare Realtime may block a session operation for up to five seconds
  # while the PeerConnection becomes usable. Leave transport and mTLS overhead
  # above that provider budget while remaining below the durable worker budget.
  @request_timeout_ms 7_000
  @certificate_types [:Certificate, :TrustedCertificate]
  @private_key_types [:PrivateKeyInfo, :RSAPrivateKey, :ECPrivateKey]

  @spec media_plane!(keyword(), pos_integer()) :: {module(), MediaPlane.t()}
  def media_plane!(options, consumer_timeout_ms) do
    if @request_timeout_ms >= consumer_timeout_ms do
      raise ArgumentError,
            "provider bridge request timeout must be shorter than the external operation timeout"
    end

    client = client!(options)
    {MediaPlane, MediaPlane.new!(client)}
  end

  @spec client!(keyword(), pos_integer()) :: Client.t()
  def client!(options, request_timeout_ms \\ @request_timeout_ms)

  def client!(options, request_timeout_ms)
      when is_list(options) and is_integer(request_timeout_ms) and request_timeout_ms > 0 do
    validate_pem_file!(
      Keyword.fetch!(options, :certfile),
      @certificate_types,
      "client certificate"
    )

    validate_pem_file!(
      Keyword.fetch!(options, :keyfile),
      @private_key_types,
      "client private key"
    )

    validate_pem_file!(Keyword.fetch!(options, :cacertfile), @certificate_types, "CA certificate")

    options
    |> Keyword.put(:connect_timeout, min(request_timeout_ms, 2_000))
    |> Keyword.put(:request_timeout, request_timeout_ms)
    |> Client.new!()
  end

  def client!(_options, _request_timeout_ms),
    do: raise(ArgumentError, "provider bridge configuration is invalid")

  defp validate_pem_file!(path, accepted_types, label) do
    case File.read(path) do
      {:ok, pem} ->
        validate_pem_contents!(pem, accepted_types, label)

      {:error, reason} ->
        raise ArgumentError,
              "provider bridge #{label} is unavailable: #{:file.format_error(reason)}"
    end
  end

  defp validate_pem_contents!(pem, accepted_types, label) do
    entries = :public_key.pem_decode(pem)

    if Enum.any?(entries, &accepted_entry?(&1, accepted_types)),
      do: :ok,
      else: raise(ArgumentError, "provider bridge #{label} is not a valid PEM file")
  end

  defp accepted_entry?({type, _contents, _cipher} = entry, accepted_types),
    do: type in accepted_types and decodable_entry?(entry)

  defp decodable_entry?(entry) do
    _decoded = :public_key.pem_entry_decode(entry)
    true
  rescue
    _exception -> false
  catch
    :exit, _reason -> false
  end
end
