defmodule ChalkSync.ProviderBridge.RecordingPlane do
  @moduledoc "API-backed provider-neutral RecordingPlane adapter."

  @behaviour ChalkSync.RecordingPlane

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.Stateholder.SessionKey

  @enforce_keys [:client]
  defstruct [:client, context: %{}]

  @type t :: %__MODULE__{client: Client.t(), context: map()}

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
      {:error, reason} -> raise ArgumentError, "invalid provider recording adapter: #{reason}"
    end
  end

  @spec with_context(t(), map() | keyword()) :: t()
  def with_context(%__MODULE__{} = adapter, context) when is_list(context),
    do: with_context(adapter, Map.new(context))

  def with_context(%__MODULE__{} = adapter, context) when is_map(context),
    do: %{adapter | context: Map.merge(adapter.context, context)}

  @impl true
  def start_recording(
        %__MODULE__{} = adapter,
        operation_id,
        %SessionKey{} = session,
        recording_id
      ) do
    operation(adapter, operation_id, session, "recording.start", recording_id)
  end

  def start_recording(_adapter, _operation_id, _session, _recording_id),
    do: {:terminal_failure, :invalid_contract}

  @impl true
  def stop_recording(%__MODULE__{} = adapter, operation_id, %SessionKey{} = session, recording_id) do
    operation(adapter, operation_id, session, "recording.stop", recording_id)
  end

  def stop_recording(_adapter, _operation_id, _session, _recording_id),
    do: {:terminal_failure, :invalid_contract}

  defp operation(adapter, operation_id, session, effect, recording_id) do
    payload = %{
      "effect" => effect,
      "tenant_id" => session.tenant_id,
      "session_id" => session.session_id,
      "recording_id" => recording_id
    }

    case Client.post_operation(context_client(adapter), operation_id, payload) do
      {:ok, outcome} ->
        outcome

      {:error, {:retryable_failure, reason}} ->
        {:retryable_failure, reason}

      {:error, {:terminal_failure, reason}} ->
        {:terminal_failure, reason}

      {:error, reason} when reason in [:invalid_contract, :invalid_source] ->
        {:terminal_failure, reason}

      {:error, reason} when is_atom(reason) ->
        {:retryable_failure, reason}

      {:error, _reason} ->
        {:retryable_failure, :transport_error}
    end
  end

  defp context_client(%__MODULE__{client: client, context: context}),
    do: Client.with_context(client, context)

  defp build(%Client{} = client, options) when is_list(options) do
    with {:ok, context} <- normalize_context(Keyword.get(options, :context, %{})) do
      {:ok, %__MODULE__{client: client, context: context}}
    end
  end

  defp build(_client, _options), do: {:error, :invalid_options}

  defp normalize_context(context) when is_map(context), do: {:ok, context}
  defp normalize_context(context) when is_list(context), do: {:ok, Map.new(context)}
  defp normalize_context(_context), do: {:error, :invalid_options}
end
