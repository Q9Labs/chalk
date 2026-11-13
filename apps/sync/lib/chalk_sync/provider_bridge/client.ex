defmodule ChalkSync.ProviderBridge.Client do
  @moduledoc """
  Bounded private HTTP client for the Sync provider-operation bridge.

  The transport is injected as a five-argument function or module callback so
  adapter tests never need a running API. The default transport delegates to
  Erlang's `:httpc` and does not add a dependency to the Sync application.
  """

  alias ChalkSync.ProviderBridge.Client.Options
  alias ChalkSync.ProviderBridge.Client.Payload
  alias ChalkSync.ProviderBridge.Codec
  alias ChalkSync.Stateholder.EpisodeKey

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
              tls: []
            ] ++ Options.limit_defaults()

  @spec new(keyword() | map()) :: {:ok, t()} | {:error, atom()}
  def new(options) when is_map(options), do: new(Map.to_list(options))

  def new(options) when is_list(options) do
    base_url = Keyword.get(options, :base_url)

    with {:ok, base_url} <- Options.validate_endpoint(base_url),
         {:ok, headers} <- Options.normalize_headers(Keyword.get(options, :headers, %{})),
         {:ok, limits} <- Options.limits(options),
         {:ok, transport} <- Options.normalize_transport(Keyword.get(options, :transport)),
         {:ok, tls} <- Options.normalize_tls(base_url, transport, options) do
      headers = Map.merge(headers, Options.context_headers(Keyword.get(options, :context, %{})))

      {:ok,
       struct!(
         __MODULE__,
         [base_url: base_url, transport: transport, headers: headers, tls: tls] ++ limits
       )}
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
    %{client | headers: Map.merge(client.headers, Options.context_headers(context))}
  end

  @spec ready(t()) :: :ok | {:error, term()}
  def ready(%__MODULE__{} = client) do
    case request(
           client,
           :get,
           client.base_url <> "/internal/v1/sync/provider-bridge/ready",
           <<>>,
           :chalk_sync_bridge_readiness
         ) do
      {:ok, %{"status" => "ready"} = response} when map_size(response) == 1 -> :ok
      {:ok, _response} -> {:error, {:retryable_failure, :malformed_response}}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec post_operation(t(), String.t(), map()) ::
          {:ok, ChalkSync.MediaPlane.outcome()} | {:error, term()}
  def post_operation(%__MODULE__{} = client, operation_id, payload)
      when is_binary(operation_id) and is_map(payload) do
    with :ok <- Payload.validate_operation_id(operation_id),
         {:ok, request_payload} <- Payload.normalize_operation_payload(payload),
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

  @spec observe_episode_publications(t(), EpisodeKey.t(), keyword()) ::
          {:ok, ChalkSync.MediaPlane.observation()} | {:error, atom()}
  def observe_episode_publications(client, episode, options \\ [])

  def observe_episode_publications(%__MODULE__{} = client, %EpisodeKey{} = episode, options) do
    with :ok <- Payload.validate_uuid(episode.tenant_id),
         :ok <- Payload.validate_uuid(episode.episode_id),
         {:ok, query} <- observation_query(client, episode, options),
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

  def observe_episode_publications(_client, _episode, _options),
    do: {:error, :invalid_contract}

  defp request(%__MODULE__{} = client, method, path, body, profile \\ :chalk_sync_bridge) do
    headers = request_headers(client.headers, method)

    options = [
      connect_timeout: client.connect_timeout,
      timeout: client.request_timeout,
      ssl: client.tls,
      profile: profile
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

  defp observation_query(client, %EpisodeKey{} = episode, options) when is_list(options) do
    limit = Keyword.get(options, :limit, client.max_observations)
    after_incarnation = Keyword.get(options, :after_incarnation)
    after_sequence = Keyword.get(options, :after_sequence)
    latest = Keyword.get(options, :latest, is_nil(after_incarnation) and is_nil(after_sequence))

    with true <- is_integer(limit) and limit > 0 and limit <= client.max_observations,
         true <-
           is_boolean(latest) and
             (not latest or (is_nil(after_incarnation) and is_nil(after_sequence))),
         {:ok, cursor_params} <- cursor_params(after_incarnation, after_sequence) do
      params =
        [{"tenant_id", episode.tenant_id}, {"episode_id", episode.episode_id}]
        |> Kernel.++(cursor_params)
        |> Kernel.++([{"limit", Integer.to_string(limit)}])
        |> Kernel.++(if latest, do: [{"latest", "true"}], else: [])

      {:ok, URI.encode_query(params)}
    else
      false -> {:error, :invalid_limit}
      {:error, reason} -> {:error, reason}
    end
  end

  defp observation_query(_client, _episode, _options), do: {:error, :invalid_contract}

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
end
