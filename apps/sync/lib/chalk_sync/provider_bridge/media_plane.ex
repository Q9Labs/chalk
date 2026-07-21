defmodule ChalkSync.ProviderBridge.MediaPlane do
  @moduledoc "API-backed provider-neutral MediaPlane adapter."

  @behaviour ChalkSync.MediaPlane

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.Stateholder.SessionKey

  @enforce_keys [:client]
  defstruct [:client, context: %{}, participant_generation_resolver: nil]

  @type t :: %__MODULE__{
          client: Client.t(),
          context: map(),
          participant_generation_resolver: function() | nil
        }

  @spec new(Client.t() | keyword() | map(), keyword()) :: {:ok, t()} | {:error, atom()}
  def new(client_or_options, options \\ [])

  def new(%Client{} = client, options), do: build(client, options)

  def new(options, adapter_options) when is_list(options) or is_map(options) do
    with {:ok, client} <- Client.new(options), do: build(client, adapter_options)
  end

  def new(_client, _options), do: {:error, :invalid_options}

  @spec new!(Client.t() | keyword() | map(), keyword()) :: t()
  def new!(client_or_options, options \\ []) do
    case new(client_or_options, options) do
      {:ok, adapter} -> adapter
      {:error, reason} -> raise ArgumentError, "invalid provider media adapter: #{reason}"
    end
  end

  @spec with_context(t(), map() | keyword()) :: t()
  def with_context(%__MODULE__{} = adapter, context) when is_list(context),
    do: with_context(adapter, Map.new(context))

  def with_context(%__MODULE__{} = adapter, context) when is_map(context),
    do: %{adapter | context: Map.merge(adapter.context, context)}

  @spec with_participant_generation(t(), String.t() | nil, pos_integer() | nil) :: t()
  def with_participant_generation(
        %__MODULE__{} = adapter,
        participant_session_id,
        generation
      )
      when is_binary(participant_session_id) and is_integer(generation) and generation > 0 do
    resolver = fn _session, candidate_id ->
      if candidate_id == participant_session_id, do: generation
    end

    %{adapter | participant_generation_resolver: resolver}
  end

  def with_participant_generation(%__MODULE__{} = adapter, _participant_session_id, _generation),
    do: %{adapter | participant_generation_resolver: nil}

  @impl true
  def grant_publication(adapter, operation_id, session, participant_session_id, source) do
    operation(adapter, operation_id, session, "media.grant_publication",
      participant_session_id: participant_session_id,
      publication_source: source
    )
  end

  @impl true
  def revoke_publication(adapter, operation_id, session, participant_session_id, source) do
    operation(adapter, operation_id, session, "media.revoke_publication",
      participant_session_id: participant_session_id,
      publication_source: source
    )
  end

  @impl true
  def remove_participant(adapter, operation_id, session, participant_session_id) do
    operation(adapter, operation_id, session, "media.remove_participant",
      participant_session_id: participant_session_id
    )
  end

  @impl true
  def end_session(adapter, operation_id, session) do
    operation(adapter, operation_id, session, "media.end_session", [])
  end

  @impl true
  def observe_session_publications(%__MODULE__{} = adapter, %SessionKey{} = session) do
    Client.observe_session_publications(context_client(adapter), session)
  end

  def observe_session_publications(_adapter, _session), do: {:error, :invalid_contract}

  defp operation(%__MODULE__{} = adapter, operation_id, %SessionKey{} = session, effect, fields) do
    payload =
      fields
      |> Keyword.put(:effect, effect)
      |> Keyword.put(:tenant_id, session.tenant_id)
      |> Keyword.put(:session_id, session.session_id)
      |> maybe_generation(adapter, session)
      |> Map.new()

    case Client.post_operation(context_client(adapter), operation_id, payload) do
      {:ok, outcome} ->
        outcome

      {:error, {:retryable_failure, reason}} ->
        {:retryable_failure, reason}

      {:error, {:terminal_failure, reason}} ->
        {:terminal_failure, reason}

      {:error, reason}
      when reason in [:invalid_contract, :invalid_source, :invalid_cursor, :invalid_limit] ->
        {:terminal_failure, reason}

      {:error, reason} when is_atom(reason) ->
        {:retryable_failure, reason}

      {:error, _reason} ->
        {:retryable_failure, :transport_error}
    end
  end

  defp operation(_adapter, _operation_id, _session, _effect, _fields),
    do: {:terminal_failure, :invalid_contract}

  defp maybe_generation(fields, %__MODULE__{participant_generation_resolver: nil}, _session),
    do: fields

  defp maybe_generation(fields, %__MODULE__{participant_generation_resolver: resolver}, session)
       when is_function(resolver) do
    participant_session_id = Keyword.get(fields, :participant_session_id)

    generation =
      cond do
        is_nil(participant_session_id) -> nil
        is_function(resolver, 2) -> resolver.(session, participant_session_id)
        is_function(resolver, 1) -> resolver.(participant_session_id)
        true -> nil
      end

    if is_integer(generation) and generation > 0,
      do: Keyword.put(fields, :participant_session_generation, generation),
      else: fields
  rescue
    _ -> fields
  end

  defp context_client(%__MODULE__{client: client, context: context}),
    do: Client.with_context(client, context)

  defp build(%Client{} = client, options) when is_list(options) do
    with {:ok, context} <- normalize_context(Keyword.get(options, :context, %{})),
         :ok <- resolver_option(Keyword.get(options, :participant_generation_resolver)) do
      {:ok,
       %__MODULE__{
         client: client,
         context: context,
         participant_generation_resolver: Keyword.get(options, :participant_generation_resolver)
       }}
    end
  end

  defp build(_client, _options), do: {:error, :invalid_options}

  defp resolver_option(nil), do: :ok
  defp resolver_option(value) when is_function(value, 1) or is_function(value, 2), do: :ok
  defp resolver_option(_value), do: {:error, :invalid_options}

  defp normalize_context(context) when is_map(context), do: {:ok, context}
  defp normalize_context(context) when is_list(context), do: {:ok, Map.new(context)}
  defp normalize_context(_context), do: {:error, :invalid_options}
end
