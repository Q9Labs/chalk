defmodule ChalkSync.ProviderBridge.Client.Options do
  @moduledoc """
  Validates and defaults the options of a provider bridge client.
  """

  @local_hosts ["localhost", "127.0.0.1", "::1"]
  @max_identifier_bytes 256

  @limit_defaults [
    max_request_bytes: 16 * 1024,
    max_response_bytes: 64 * 1024,
    max_observations: 100,
    max_publications: 100,
    connect_timeout: 2_000,
    request_timeout: 5_000
  ]

  def validate_endpoint(base_url) when is_binary(base_url) do
    case URI.parse(base_url) do
      %URI{scheme: "https", host: host, userinfo: nil, query: nil, fragment: nil}
      when is_binary(host) and host != "" ->
        {:ok, String.trim_trailing(base_url, "/")}

      %URI{scheme: "http", host: host, userinfo: nil, query: nil, fragment: nil}
      when host in @local_hosts ->
        {:ok, String.trim_trailing(base_url, "/")}

      %URI{scheme: "http", host: host} when is_binary(host) ->
        {:error, :insecure_endpoint}

      _ ->
        {:error, :invalid_endpoint}
    end
  end

  def validate_endpoint(_base_url), do: {:error, :invalid_endpoint}

  def normalize_transport(nil),
    do: {:ok, {ChalkSync.ProviderBridge.Transport.ErlangHTTP, :request}}

  def normalize_transport(transport) when is_function(transport, 5), do: {:ok, transport}
  def normalize_transport(transport) when is_function(transport, 1), do: {:ok, transport}

  def normalize_transport({module, function}) when is_atom(module) and is_atom(function),
    do: {:ok, {module, function}}

  def normalize_transport(_transport), do: {:error, :invalid_transport}

  def normalize_tls(base_url, transport, options) do
    tls = [
      certfile: Keyword.get(options, :tls_certfile, Keyword.get(options, :certfile)),
      keyfile: Keyword.get(options, :tls_keyfile, Keyword.get(options, :keyfile)),
      cacertfile: Keyword.get(options, :tls_cacertfile, Keyword.get(options, :cacertfile))
    ]

    if https?(base_url) and default_transport?(transport) and not complete_tls?(tls),
      do: {:error, :mtls_configuration_required},
      else: {:ok, Enum.reject(tls, fn {_key, value} -> is_nil(value) end)}
  end

  defp default_transport?({ChalkSync.ProviderBridge.Transport.ErlangHTTP, :request}), do: true
  defp default_transport?(_transport), do: false

  defp complete_tls?(tls),
    do: Enum.all?(tls, fn {_key, value} -> is_binary(value) and byte_size(value) > 0 end)

  defp https?(url), do: URI.parse(url).scheme == "https"

  def normalize_headers(headers) when is_map(headers) do
    Enum.reduce_while(headers, {:ok, %{}}, fn {key, value}, {:ok, acc} ->
      key = normalize_header_key(key)

      if is_binary(key) and is_binary(value) and byte_size(value) <= @max_identifier_bytes,
        do: {:cont, {:ok, Map.put(acc, key, value)}},
        else: {:halt, {:error, :invalid_headers}}
    end)
  end

  def normalize_headers(headers) when is_list(headers), do: normalize_headers(Map.new(headers))
  def normalize_headers(_headers), do: {:error, :invalid_headers}

  defp normalize_header_key(key) when is_atom(key),
    do: key |> Atom.to_string() |> String.downcase()

  defp normalize_header_key(key) when is_binary(key), do: String.downcase(key)
  defp normalize_header_key(_key), do: nil

  def context_headers(context) when is_list(context), do: context_headers(Map.new(context))

  def context_headers(context) when is_map(context) do
    Enum.reduce(context, %{}, &put_context_header/2)
  end

  def context_headers(_context), do: %{}

  defp put_context_header({key, value}, headers) when is_binary(value) do
    case context_header_name(key) do
      nil -> headers
      name -> Map.put(headers, name, value)
    end
  end

  defp put_context_header(_entry, headers), do: headers

  defp context_header_name(key) when key in [:journey_id, "journey_id", "x-chalk-journey-id"],
    do: "x-chalk-journey-id"

  defp context_header_name(key) when key in [:traceparent, "traceparent"], do: "traceparent"
  defp context_header_name(key) when key in [:tracestate, "tracestate"], do: "tracestate"
  defp context_header_name(_key), do: nil

  def limit_defaults, do: @limit_defaults

  def limits(options) do
    limits =
      Keyword.new(@limit_defaults, fn {key, default} ->
        {key, Keyword.get(options, key, default)}
      end)

    if Enum.all?(limits, fn {_key, value} -> is_integer(value) and value > 0 end),
      do: {:ok, limits},
      else: {:error, :invalid_options}
  end
end
