defmodule ChalkSync.ProviderBridge.Transport.ErlangHTTP do
  @moduledoc "Default dependency-free transport for the private provider bridge."

  @spec request(atom(), binary(), [{binary(), binary()}], binary(), keyword()) ::
          {:ok, non_neg_integer(), [{binary(), binary()}], binary()} | {:error, term()}
  def request(method, url, headers, body, options) when method in [:get, :post] do
    :inets.start()
    :ssl.start()

    request =
      case method do
        :get ->
          {String.to_charlist(url), headers_to_charlists(headers)}

        :post ->
          {String.to_charlist(url), headers_to_charlists(headers), content_type(method), body}
      end

    http_options =
      [
        timeout: Keyword.fetch!(options, :timeout),
        connect_timeout: Keyword.fetch!(options, :connect_timeout)
      ] ++ ssl_options(url, Keyword.get(options, :ssl, []))

    case :httpc.request(method, request, http_options, [{:body_format, :binary}]) do
      {:ok, {{_version, status, _reason}, response_headers, response_body}} ->
        {:ok, status, headers_to_binaries(response_headers), response_body}

      {:error, reason} ->
        {:error, reason}
    end
  rescue
    _ -> {:error, :transport_error}
  catch
    :exit, reason -> {:error, reason}
  end

  defp content_type(:post), do: ~c"application/json"
  defp content_type(:get), do: ~c"application/json"

  defp ssl_options(_url, []), do: []

  defp ssl_options(url, options) do
    uri = URI.parse(url)

    [
      ssl: [
        verify: :verify_peer,
        versions: [:"tlsv1.3"],
        server_name_indication: String.to_charlist(uri.host),
        customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)],
        cacertfile: String.to_charlist(Keyword.fetch!(options, :cacertfile)),
        certfile: String.to_charlist(Keyword.fetch!(options, :certfile)),
        keyfile: String.to_charlist(Keyword.fetch!(options, :keyfile))
      ]
    ]
  end

  defp headers_to_charlists(headers),
    do:
      Enum.map(headers, fn {key, value} ->
        {String.to_charlist(key), String.to_charlist(value)}
      end)

  defp headers_to_binaries(headers),
    do: Enum.map(headers, fn {key, value} -> {to_string(key), to_string(value)} end)
end
