defmodule ChalkSync.Diagnostics.Transport do
  @moduledoc "Bounded HTTP append seam for the internal Episode Diagnostic intake."

  alias ChalkSync.Diagnostics.ServiceCredential

  @path "/_internal/episode-diagnostic-events"
  @max_response_bytes 256 * 1024
  @local_hosts ["localhost", "127.0.0.1", "::1"]
  @max_allowed_hosts 64

  @type response ::
          {:ok, map()}
          | {:retryable, atom()}
          | {:terminal, atom()}

  @spec append(map(), map(), [map()]) :: response()
  def append(config, scope, events)
      when is_map(config) and is_map(scope) and is_list(events) and events != [] do
    case validate_config(config) do
      :ok -> append_valid(config, scope, events)
      {:error, _reason} -> {:terminal, :invalid_contract}
    end
  rescue
    _exception -> {:retryable, :transport_error}
  catch
    :exit, _reason -> {:retryable, :transport_error}
  end

  def append(_config, _scope, _events), do: {:terminal, :invalid_contract}

  @doc false
  @spec validate_resolved_addresses([tuple()], atom()) :: :ok | {:error, atom()}
  def validate_resolved_addresses(addresses, mode) when is_list(addresses) do
    validate_addresses(addresses, mode)
  end

  def validate_resolved_addresses(_addresses, _mode), do: {:error, :destination_blocked}

  @spec validate_config(map()) :: :ok | {:error, atom()}
  def validate_config(config) when is_map(config) do
    with :ok <- validate_url(config[:base_url], config[:mode], config[:allowed_hosts]),
         true <- valid_authentication?(config),
         true <- is_binary(config[:instance_id]) and byte_size(config.instance_id) in 8..128,
         true <- is_integer(config[:generation]) and config.generation in 1..2_147_483_648,
         true <- is_integer(config[:connect_timeout_ms]) and config.connect_timeout_ms > 0,
         true <- is_integer(config[:request_timeout_ms]) and config.request_timeout_ms > 0,
         true <- is_integer(config[:max_request_bytes]) and config.max_request_bytes > 0 do
      :ok
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, :invalid_config}
    end
  end

  def validate_config(_config), do: {:error, :invalid_config}

  @doc false
  @spec authorization(map()) :: {:ok, binary()} | {:error, :credential_unavailable}
  def authorization(%{mode: :localhost, token: token})
      when is_binary(token) and byte_size(token) in 16..4096,
      do: {:ok, token}

  def authorization(%{mode: :hosted, credential: credential}) do
    ServiceCredential.issue(credential)
  end

  def authorization(_config), do: {:error, :credential_unavailable}

  defp append_valid(config, scope, events) do
    body = %{
      "version" => 1,
      "producer" => %{
        "id" => "sync",
        "instanceId" => config.instance_id,
        "generation" => config.generation
      },
      "scope" => scope,
      "events" => events
    }

    with {:ok, encoded} <- encode_body(body, config.max_request_bytes),
         :ok <- validate_destination(config),
         {:ok, status, response_body} <- request(config, encoded) do
      case decode_response(status, response_body) do
        {:ok, response} -> validate_response_membership(response, events)
        result -> result
      end
    else
      {:error, :request_too_large} -> {:terminal, :invalid_contract}
      {:error, :destination_blocked} -> {:terminal, :invalid_contract}
      {:error, :dns_failed} -> {:retryable, :transport_error}
      {:error, reason} when reason in [:timeout, :connect_timeout] -> {:retryable, :timeout}
      {:error, _reason} -> {:retryable, :transport_error}
    end
  end

  defp request(config, encoded) do
    :inets.start()
    :ssl.start()
    url = config.base_url <> @path

    with {:ok, token} <- authorization(config) do
      request = {
        String.to_charlist(url),
        [
          {~c"authorization", String.to_charlist("Bearer " <> token)},
          {~c"accept", ~c"application/json"}
        ],
        ~c"application/json",
        encoded
      }

      http_options = [
        timeout: config.request_timeout_ms,
        connect_timeout: config.connect_timeout_ms,
        autoredirect: false
      ]

      http_options =
        if URI.parse(config.base_url).scheme == "https",
          do: Keyword.put(http_options, :ssl, tls_options(config.base_url)),
          else: http_options

      case :httpc.request(:post, request, http_options, body_format: :binary) do
        {:ok, {{_version, status, _reason}, _headers, body}}
        when is_binary(body) and byte_size(body) <= @max_response_bytes ->
          {:ok, status, body}

        {:ok, {{_version, _status, _reason}, _headers, _oversized}} ->
          {:error, :response_too_large}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp decode_response(200, body) do
    case JSON.decode(body) do
      {:ok, response} when is_map(response) -> validate_success(response)
      _ -> {:terminal, :malformed_response}
    end
  end

  defp decode_response(status, _body) when status in [429, 500, 502, 503, 504],
    do: {:retryable, :server_unavailable}

  defp decode_response(status, _body) when status in [401, 403], do: {:terminal, :unauthorized}
  defp decode_response(404, _body), do: {:terminal, :scope_not_found}
  defp decode_response(status, _body) when status in 400..499, do: {:terminal, :invalid_contract}
  defp decode_response(_status, _body), do: {:retryable, :server_unavailable}

  defp validate_success(response) do
    with true <- is_binary(response["diagnosticReference"]),
         true <- is_integer(response["committedCursor"]) and response["committedCursor"] >= 0,
         {:ok, accepted} <- event_results(response["accepted"]),
         {:ok, duplicates} <- event_results(response["duplicates"]),
         {:ok, conflicts} <- conflicts(response["conflicts"]) do
      {:ok, %{accepted: accepted, duplicates: duplicates, conflicts: conflicts}}
    else
      _ -> {:terminal, :malformed_response}
    end
  end

  defp event_results(values) when is_list(values) do
    if Enum.all?(values, fn value ->
         is_map(value) and is_binary(value["eventId"]) and
           is_integer(value["cursor"]) and value["cursor"] >= 0
       end),
       do: {:ok, Enum.map(values, & &1["eventId"])},
       else: {:error, :malformed_response}
  end

  defp event_results(_values), do: {:error, :malformed_response}

  defp conflicts(values) when is_list(values) do
    if Enum.all?(values, fn value ->
         is_map(value) and is_binary(value["eventId"]) and
           value["code"] == "fingerprint_mismatch"
       end),
       do: {:ok, Enum.map(values, & &1["eventId"])},
       else: {:error, :malformed_response}
  end

  defp conflicts(_values), do: {:error, :malformed_response}

  defp validate_response_membership(response, events) do
    requested = events |> Enum.map(& &1["eventId"]) |> MapSet.new()
    returned_ids = response.accepted ++ response.duplicates ++ response.conflicts
    returned = MapSet.new(returned_ids)

    if MapSet.subset?(returned, requested) and MapSet.size(returned) == length(returned_ids),
      do: {:ok, response},
      else: {:terminal, :malformed_response}
  end

  defp encode_body(body, max_bytes) do
    encoded = JSON.encode!(body)
    if byte_size(encoded) <= max_bytes, do: {:ok, encoded}, else: {:error, :request_too_large}
  end

  defp validate_url(url, mode, allowed_hosts) when is_binary(url) do
    url |> URI.parse() |> validate_uri(mode, allowed_hosts)
  end

  defp validate_url(_url, _mode, _allowed_hosts), do: {:error, :invalid_url}

  defp validate_destination(%{base_url: base_url, mode: mode}) do
    case URI.parse(base_url).host do
      host when is_binary(host) ->
        with {:ok, addresses} <- resolve_addresses(host),
             do: validate_addresses(addresses, mode)

      _invalid ->
        {:error, :destination_blocked}
    end
  end

  defp validate_destination(_config), do: {:error, :destination_blocked}

  defp resolve_addresses(host) when is_binary(host) do
    case :inet.parse_address(String.to_charlist(host)) do
      {:ok, address} ->
        {:ok, [address]}

      {:error, _reason} ->
        addresses =
          [:inet, :inet6]
          |> Enum.flat_map(&resolve_address_family(host, &1))
          |> Enum.uniq()

        if addresses == [], do: {:error, :dns_failed}, else: {:ok, addresses}
    end
  end

  defp resolve_address_family(host, family) do
    case :inet.getaddrs(String.to_charlist(host), family) do
      {:ok, values} -> values
      {:error, _reason} -> []
    end
  end

  defp validate_addresses(addresses, :localhost) do
    if Enum.all?(addresses, &loopback_address?/1), do: :ok, else: {:error, :destination_blocked}
  end

  defp validate_addresses(addresses, :hosted) do
    if Enum.all?(addresses, &(not blocked_address?(&1))),
      do: :ok,
      else: {:error, :destination_blocked}
  end

  defp validate_addresses(_addresses, _mode), do: {:error, :destination_blocked}

  defp loopback_address?({127, _b, _c, _d}), do: true
  defp loopback_address?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp loopback_address?(_address), do: false

  defp blocked_address?({a, _b, _c, _d}) when a in [0, 10, 127] or a >= 224, do: true

  defp blocked_address?({169, 254, _c, _d}), do: true
  defp blocked_address?({172, b, _c, _d}) when b in 16..31, do: true
  defp blocked_address?({192, 0, 0, _d}), do: true
  defp blocked_address?({192, 0, 2, _d}), do: true
  defp blocked_address?({192, 168, _c, _d}), do: true
  defp blocked_address?({198, 18, _c, _d}), do: true
  defp blocked_address?({198, 19, _c, _d}), do: true
  defp blocked_address?({198, 51, 100, _d}), do: true
  defp blocked_address?({203, 0, 113, _d}), do: true
  defp blocked_address?({100, b, _c, _d}) when b in 64..127, do: true
  defp blocked_address?({255, 255, 255, 255}), do: true

  defp blocked_address?({_, _, _, _, _, _, _, _} = address) do
    ipv4_mapped? = ipv4_mapped?(address)
    ipv4_blocked? = ipv4_mapped? and blocked_address?(mapped_ipv4(address))

    ipv4_mapped? or ipv4_blocked? or blocked_ipv6_address?(address)
  end

  defp blocked_address?(_address), do: true

  defp ipv4_mapped?({0, 0, 0, 0, 0, 65_535, _g, _h}), do: true
  defp ipv4_mapped?(_address), do: false

  defp mapped_ipv4({_a, _b, _c, _d, _e, _f, g, h}),
    do: {Bitwise.bsr(g, 8), Bitwise.band(g, 255), Bitwise.bsr(h, 8), Bitwise.band(h, 255)}

  defp blocked_ipv6_address?(address) do
    ipv6_unspecified?(address) or ipv6_loopback?(address) or
      ipv6_link_local_or_multicast?(address) or ipv6_private_or_documentation?(address)
  end

  defp ipv6_unspecified?({0, 0, 0, 0, 0, 0, 0, 0}), do: true
  defp ipv6_unspecified?(_address), do: false

  defp ipv6_loopback?({0, 0, 0, 0, 0, 0, 0, 1}), do: true
  defp ipv6_loopback?(_address), do: false

  defp ipv6_link_local_or_multicast?({a, _b, _c, _d, _e, _f, _g, _h}),
    do: a in 64_512..65_535

  defp ipv6_private_or_documentation?({a, b, c, d, _e, _f, _g, _h}) do
    (a == 256 and b == 0 and c == 0 and d == 0) or (a == 8193 and b == 3512)
  end

  defp validate_allowed_hosts(hosts, mode)
       when is_list(hosts) and length(hosts) in 1..@max_allowed_hosts and
              mode in [:localhost, :hosted] do
    normalized = Enum.map(hosts, &normalize_host/1)

    if Enum.all?(normalized, &valid_allowed_host?(&1, mode)) and
         Enum.uniq(normalized) == normalized,
       do: {:ok, normalized},
       else: {:error, :invalid_url}
  end

  defp validate_allowed_hosts(_hosts, _mode), do: {:error, :invalid_url}

  defp normalize_host(host) when is_binary(host),
    do: host |> String.trim() |> String.downcase() |> String.trim_trailing(".")

  defp normalize_host(_host), do: nil

  defp valid_allowed_host?(host, :localhost) when is_binary(host) and byte_size(host) in 1..253 do
    host in @local_hosts or
      case :inet.parse_address(String.to_charlist(host)) do
        {:ok, address} -> loopback_address?(address)
        {:error, _reason} -> false
      end
  end

  defp valid_allowed_host?(host, :hosted) when is_binary(host) and byte_size(host) in 1..253 do
    host not in @local_hosts and
      not match?({:ok, _address}, :inet.parse_address(String.to_charlist(host))) and
      not String.contains?(host, ["/", "?", "#", "@", ":", "\\", "*"]) and
      not String.contains?(host, " ")
  end

  defp valid_allowed_host?(_host, _mode), do: false

  defp valid_authentication?(
         %{
           mode: :localhost,
           token: token
         } = config
       ) do
    is_binary(token) and byte_size(token) in 16..4096 and is_nil(config[:credential])
  end

  defp valid_authentication?(
         %{
           mode: :hosted,
           instance_id: instance_id,
           generation: generation,
           credential: credential
         } = config
       ) do
    is_nil(config[:token]) and
      ServiceCredential.bound_to?(credential, "sync", instance_id, generation)
  end

  defp valid_authentication?(_config), do: false

  defp validate_uri(
         %URI{
           scheme: "http",
           host: host,
           path: path,
           userinfo: nil,
           query: nil,
           fragment: nil
         },
         :localhost,
         allowed_hosts
       )
       when host in @local_hosts and path in [nil, "", "/"] do
    with {:ok, normalized} <- validate_allowed_hosts(allowed_hosts, :localhost),
         true <- normalize_host(host) in normalized do
      :ok
    else
      _invalid -> {:error, :invalid_url}
    end
  end

  defp validate_uri(
         %URI{
           scheme: "https",
           host: host,
           path: path,
           userinfo: nil,
           query: nil,
           fragment: nil
         },
         :hosted,
         allowed_hosts
       )
       when is_binary(host) and host != "" and path in [nil, "", "/"] do
    with {:ok, normalized} <- validate_allowed_hosts(allowed_hosts, :hosted),
         true <- normalize_host(host) in normalized do
      :ok
    else
      _invalid -> {:error, :invalid_url}
    end
  end

  defp validate_uri(_uri, _mode, _allowed_hosts), do: {:error, :invalid_url}

  defp tls_options(url) do
    host = URI.parse(url).host

    [
      verify: :verify_peer,
      cacerts: :public_key.cacerts_get(),
      server_name_indication: String.to_charlist(host),
      customize_hostname_check: [match_fun: :public_key.pkix_verify_hostname_match_fun(:https)]
    ]
  end
end
