defmodule ChalkSync.ProviderBridge.Client do
  @moduledoc """
  Bounded private HTTP client for the Sync provider-operation bridge.

  The transport is injected as a five-argument function or module callback so
  adapter tests never need a running API. The default transport delegates to
  Erlang's `:httpc` and does not add a dependency to the Sync application.
  """

  alias ChalkSync.ProviderBridge.Codec
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @default_request_bytes 16 * 1024
  @default_response_bytes 64 * 1024
  @default_connect_timeout 2_000
  @default_request_timeout 5_000
  @default_observation_limit 100
  @max_operation_id_bytes 128
  @max_identifier_bytes 256
  @local_hosts ["localhost", "127.0.0.1", "::1"]
  @effects ~w(media.grant_publication media.revoke_publication media.remove_participant media.end_session recording.start recording.stop)
  @sources ~w(microphone camera screen)

  @type transport_response ::
          {:ok, non_neg_integer(), [{binary(), binary()}], binary()}
          | {:ok, binary()}
          | {:error, term()}
  @type transport :: (atom(), binary(), [{binary(), binary()}], binary(), keyword() ->
                        transport_response())

  @type t :: %__MODULE__{
          base_url: binary(),
          transport: transport() | {module(), atom()},
          headers: %{optional(binary()) => binary()},
          max_request_bytes: pos_integer(),
          max_response_bytes: pos_integer(),
          max_observations: pos_integer(),
          max_publications: pos_integer(),
          connect_timeout: pos_integer(),
          request_timeout: pos_integer(),
          tls: keyword()
        }

  @enforce_keys [:base_url]
  defstruct [
    :base_url,
    transport: {ChalkSync.ProviderBridge.Transport.ErlangHTTP, :request},
    headers: %{},
    max_request_bytes: @default_request_bytes,
    max_response_bytes: @default_response_bytes,
    max_observations: @default_observation_limit,
    max_publications: @default_observation_limit,
    connect_timeout: @default_connect_timeout,
    request_timeout: @default_request_timeout,
    tls: []
  ]

  @spec new(keyword() | map()) :: {:ok, t()} | {:error, atom()}
  def new(options) when is_map(options), do: new(Map.to_list(options))

  def new(options) when is_list(options) do
    base_url = Keyword.get(options, :base_url)

    with {:ok, base_url} <- validate_endpoint(base_url),
         {:ok, headers} <- normalize_headers(Keyword.get(options, :headers, %{})),
         :ok <- positive_options(options),
         {:ok, transport} <- normalize_transport(Keyword.get(options, :transport)),
         {:ok, tls} <- normalize_tls(base_url, transport, options) do
      headers = Map.merge(headers, context_headers(Keyword.get(options, :context, %{})))

      {:ok,
       %__MODULE__{
         base_url: base_url,
         transport: transport,
         headers: headers,
         max_request_bytes: Keyword.get(options, :max_request_bytes, @default_request_bytes),
         max_response_bytes: Keyword.get(options, :max_response_bytes, @default_response_bytes),
         max_observations: Keyword.get(options, :max_observations, @default_observation_limit),
         max_publications: Keyword.get(options, :max_publications, @default_observation_limit),
         connect_timeout: Keyword.get(options, :connect_timeout, @default_connect_timeout),
         request_timeout: Keyword.get(options, :request_timeout, @default_request_timeout),
         tls: tls
       }}
    end
  end

  def new(_options), do: {:error, :invalid_options}

  @spec new!(keyword() | map()) :: t()
  def new!(options) do
    case new(options) do
      {:ok, client} -> client
      {:error, reason} -> raise ArgumentError, "invalid provider bridge client: #{reason}"
    end
  end

  @spec with_context(t(), map() | keyword()) :: t()
  def with_context(%__MODULE__{} = client, context) do
    %{client | headers: Map.merge(client.headers, context_headers(context))}
  end

  @spec ready(t()) :: :ok | {:error, term()}
  def ready(%__MODULE__{} = client) do
    case request(client, :get, client.base_url <> "/internal/v1/sync/provider-bridge/ready", <<>>) do
      {:ok, %{"status" => "ready"} = response} when map_size(response) == 1 -> :ok
      {:ok, _response} -> {:error, {:retryable_failure, :malformed_response}}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec post_operation(t(), String.t(), map()) ::
          {:ok, ChalkSync.MediaPlane.outcome()} | {:error, term()}
  def post_operation(%__MODULE__{} = client, operation_id, payload)
      when is_binary(operation_id) and is_map(payload) do
    with :ok <- validate_operation_id(operation_id),
         {:ok, request_payload} <- normalize_operation_payload(payload),
         {:ok, body} <- encode_bounded(request_payload, client.max_request_bytes),
         {:ok, response} <- request(client, :post, operation_path(client, operation_id), body),
         {:ok, decoded} <-
           Codec.decode_operation_response(response, operation_id, request_payload) do
      {:ok, decoded}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  def post_operation(_client, _operation_id, _payload),
    do: {:error, {:terminal_failure, :invalid_contract}}

  @spec observe_session_publications(t(), SessionKey.t(), keyword()) ::
          {:ok, ChalkSync.MediaPlane.observation()} | {:error, atom()}
  def observe_session_publications(client, session, options \\ [])

  def observe_session_publications(%__MODULE__{} = client, %SessionKey{} = session, options) do
    with :ok <- validate_uuid(session.tenant_id),
         :ok <- validate_uuid(session.session_id),
         {:ok, query} <- observation_query(client, session, options),
         {:ok, response} <- request(client, :get, observation_path(client, query), <<>>),
         {:ok, observation} <-
           Codec.decode_observation_response(
             response,
             client.max_observations,
             client.max_publications
           ) do
      {:ok, observation}
    else
      {:error, {:retryable_failure, reason}} -> {:error, reason}
      {:error, {:terminal_failure, reason}} -> {:error, reason}
      {:error, reason} when is_atom(reason) -> {:error, reason}
      {:error, _reason} -> {:error, :malformed_response}
    end
  end

  def observe_session_publications(_client, _session, _options),
    do: {:error, :invalid_contract}

  defp request(%__MODULE__{} = client, method, path, body) do
    headers = request_headers(client.headers, method)

    options = [
      connect_timeout: client.connect_timeout,
      timeout: client.request_timeout,
      ssl: client.tls
    ]

    case safe_transport(client.transport, method, path, headers, body, options) do
      {:ok, status, _response_headers, response_body} when is_integer(status) ->
        Codec.normalize_response(status, response_body, client.max_response_bytes)

      {:ok, response_body} ->
        Codec.normalize_response(200, response_body, client.max_response_bytes)

      {:error, reason} ->
        {:error, transport_failure(reason)}

      _invalid ->
        {:error, {:retryable_failure, :transport_error}}
    end
  end

  defp safe_transport(transport, method, path, headers, body, options) do
    invoke_transport(transport, method, path, headers, body, options)
  rescue
    _ -> {:error, :transport_error}
  catch
    :exit, reason -> {:error, reason}
  end

  defp invoke_transport(transport, method, path, headers, body, options)
       when is_function(transport, 5),
       do: transport.(method, path, headers, body, options)

  defp invoke_transport(transport, method, path, headers, body, options)
       when is_function(transport, 1),
       do:
         transport.(%{method: method, url: path, headers: headers, body: body, options: options})

  defp invoke_transport({module, function}, method, path, headers, body, options)
       when is_atom(module) and is_atom(function),
       do: apply(module, function, [method, path, headers, body, options])

  defp invoke_transport(_transport, _method, _path, _headers, _body, _options),
    do: {:error, :invalid_transport}

  defp observation_query(client, %SessionKey{} = session, options) when is_list(options) do
    limit = Keyword.get(options, :limit, client.max_observations)
    after_incarnation = Keyword.get(options, :after_incarnation)
    after_sequence = Keyword.get(options, :after_sequence)

    with true <- is_integer(limit) and limit > 0 and limit <= client.max_observations,
         {:ok, cursor_params} <- cursor_params(after_incarnation, after_sequence) do
      params =
        [{"tenant_id", session.tenant_id}, {"session_id", session.session_id}]
        |> Kernel.++(cursor_params)
        |> Kernel.++([{"limit", Integer.to_string(limit)}])

      {:ok, URI.encode_query(params)}
    else
      false -> {:error, :invalid_limit}
      {:error, reason} -> {:error, reason}
    end
  end

  defp observation_query(_client, _session, _options), do: {:error, :invalid_contract}

  defp cursor_params(nil, nil), do: {:ok, []}

  defp cursor_params(incarnation, sequence)
       when is_integer(incarnation) and incarnation >= 0 and is_integer(sequence) and
              sequence >= 0,
       do:
         {:ok,
          [
            {"after_incarnation", Integer.to_string(incarnation)},
            {"after_sequence", Integer.to_string(sequence)}
          ]}

  defp cursor_params(_incarnation, _sequence), do: {:error, :invalid_cursor}

  defp operation_path(client, operation_id),
    do:
      client.base_url <>
        "/internal/v1/sync/provider-operations/" <> URI.encode_www_form(operation_id)

  defp observation_path(client, query),
    do: client.base_url <> "/internal/v1/sync/media-observations?" <> query

  defp normalize_operation_payload(payload) do
    payload =
      Enum.reduce(payload, %{}, fn {key, value}, acc ->
        key = if is_atom(key), do: Atom.to_string(key), else: key
        Map.put(acc, key, value)
      end)

    with {:ok, effect} <- normalize_effect(payload["effect"] || payload[:effect]),
         {:ok, tenant_id} <- required_payload_uuid(payload, "tenant_id"),
         {:ok, session_id} <- required_payload_uuid(payload, "session_id"),
         {:ok, result} <- optional_payload_fields(payload) do
      {:ok,
       result
       |> Map.merge(%{"effect" => effect, "tenant_id" => tenant_id, "session_id" => session_id})
       |> Map.take(
         ~w(effect tenant_id session_id participant_session_id participant_session_generation publication_source recording_id)
       )}
    end
  end

  defp optional_payload_fields(payload) do
    fields = [
      {"participant_session_id", :uuid},
      {"participant_session_generation", :positive_integer},
      {"publication_source", :source},
      {"recording_id", :uuid}
    ]

    Enum.reduce_while(fields, {:ok, %{}}, &put_optional_payload_field(&1, &2, payload))
  end

  defp put_optional_payload_field({key, kind}, {:ok, acc}, payload) do
    case Map.fetch(payload, key) do
      :error -> {:cont, {:ok, acc}}
      {:ok, value} -> validate_optional_payload_field(key, kind, value, acc)
    end
  end

  defp validate_optional_payload_field(key, kind, value, acc) do
    case validate_payload_value(kind, value) do
      :ok -> {:cont, {:ok, Map.put(acc, key, normalize_payload_value(kind, value))}}
      {:error, reason} -> {:halt, {:error, reason}}
    end
  end

  defp validate_payload_value(:uuid, value), do: validate_uuid(value)

  defp validate_payload_value(:positive_integer, value),
    do: if(is_integer(value) and value > 0, do: :ok, else: {:error, :invalid_contract})

  defp validate_payload_value(:source, value),
    do: if(source_string(value), do: :ok, else: {:error, :invalid_source})

  defp normalize_payload_value(:source, value), do: source_string(value)
  defp normalize_payload_value(_kind, value), do: value

  defp required_payload_uuid(payload, key) do
    case Map.fetch(payload, key) do
      {:ok, value} ->
        if(validate_uuid(value) == :ok, do: {:ok, value}, else: {:error, :invalid_contract})

      :error ->
        {:error, {:terminal_failure, :invalid_contract}}
    end
  end

  defp normalize_effect(effect) when is_atom(effect), do: normalize_effect(Atom.to_string(effect))
  defp normalize_effect(effect) when is_binary(effect) and effect in @effects, do: {:ok, effect}
  defp normalize_effect(_effect), do: {:error, {:terminal_failure, :invalid_contract}}

  defp source_string(source) when is_atom(source) do
    value = Atom.to_string(source)
    if value in @sources, do: value, else: nil
  end

  defp source_string(source) when is_binary(source),
    do: if(source in @sources, do: source, else: nil)

  defp source_string(_source), do: nil

  defp transport_failure(:timeout), do: {:retryable_failure, :timeout}
  defp transport_failure(:connect_timeout), do: {:retryable_failure, :timeout}
  defp transport_failure(:econnrefused), do: {:retryable_failure, :provider_unavailable}

  defp transport_failure({:failed_connect, _reason}),
    do: {:retryable_failure, :provider_unavailable}

  defp transport_failure(_reason), do: {:retryable_failure, :transport_error}

  defp encode_bounded(payload, limit) do
    body = JSON.encode!(payload)

    if byte_size(body) <= limit,
      do: {:ok, body},
      else: {:error, {:terminal_failure, :request_too_large}}
  rescue
    _ -> {:error, {:terminal_failure, :invalid_contract}}
  end

  defp validate_endpoint(base_url) when is_binary(base_url) do
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

  defp validate_endpoint(_base_url), do: {:error, :invalid_endpoint}

  defp normalize_transport(nil),
    do: {:ok, {ChalkSync.ProviderBridge.Transport.ErlangHTTP, :request}}

  defp normalize_transport(transport) when is_function(transport, 5), do: {:ok, transport}
  defp normalize_transport(transport) when is_function(transport, 1), do: {:ok, transport}

  defp normalize_transport({module, function}) when is_atom(module) and is_atom(function),
    do: {:ok, {module, function}}

  defp normalize_transport(_transport), do: {:error, :invalid_transport}

  defp normalize_tls(base_url, transport, options) do
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

  defp normalize_headers(headers) when is_map(headers) do
    Enum.reduce_while(headers, {:ok, %{}}, fn {key, value}, {:ok, acc} ->
      key = normalize_header_key(key)

      if is_binary(key) and is_binary(value) and byte_size(value) <= @max_identifier_bytes,
        do: {:cont, {:ok, Map.put(acc, key, value)}},
        else: {:halt, {:error, :invalid_headers}}
    end)
  end

  defp normalize_headers(headers) when is_list(headers), do: normalize_headers(Map.new(headers))
  defp normalize_headers(_headers), do: {:error, :invalid_headers}

  defp normalize_header_key(key) when is_atom(key),
    do: key |> Atom.to_string() |> String.downcase()

  defp normalize_header_key(key) when is_binary(key), do: String.downcase(key)
  defp normalize_header_key(_key), do: nil

  defp context_headers(context) when is_list(context), do: context_headers(Map.new(context))

  defp context_headers(context) when is_map(context) do
    Enum.reduce(context, %{}, &put_context_header/2)
  end

  defp context_headers(_context), do: %{}

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

  defp request_headers(headers, :post),
    do:
      headers
      |> Map.put_new("content-type", "application/json")
      |> Map.put_new("accept", "application/json")
      |> Enum.map(fn {key, value} -> {key, value} end)

  defp request_headers(headers, :get),
    do:
      headers
      |> Map.put_new("accept", "application/json")
      |> Enum.map(fn {key, value} -> {key, value} end)

  defp positive_options(options) do
    keys = [
      :max_request_bytes,
      :max_response_bytes,
      :max_observations,
      :max_publications,
      :connect_timeout,
      :request_timeout
    ]

    if Enum.all?(keys, fn key ->
         is_integer(Keyword.get(options, key, default_option(key))) and
           Keyword.get(options, key, default_option(key)) > 0
       end), do: :ok, else: {:error, :invalid_options}
  end

  defp default_option(:max_request_bytes), do: @default_request_bytes
  defp default_option(:max_response_bytes), do: @default_response_bytes
  defp default_option(:max_observations), do: @default_observation_limit
  defp default_option(:max_publications), do: @default_observation_limit
  defp default_option(:connect_timeout), do: @default_connect_timeout
  defp default_option(:request_timeout), do: @default_request_timeout

  defp validate_uuid(value) when is_binary(value) do
    if value != String.downcase(value) do
      {:error, :invalid_contract}
    else
      case UUID.dump(value) do
        {:ok, _binary} -> :ok
        :error -> {:error, :invalid_contract}
      end
    end
  end

  defp validate_uuid(_value), do: {:error, :invalid_contract}

  defp validate_operation_id(value)
       when is_binary(value) and byte_size(value) >= 16 and
              byte_size(value) <= @max_operation_id_bytes,
       do:
         if(Regex.match?(~r/\A[A-Za-z0-9_-]{16,128}\z/, value),
           do: :ok,
           else: {:error, {:terminal_failure, :invalid_contract}}
         )

  defp validate_operation_id(_value), do: {:error, {:terminal_failure, :invalid_contract}}
end
