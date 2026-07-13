defmodule ChalkSync.DeliveryGate do
  @moduledoc """
  Controls delivery at the boundaries where durable work becomes an observable hint or frame.

  Production uses the immediate adapter. Deterministic fault campaigns may install an adapter
  that blocks or drops a named delivery without changing the durable transaction being tested.
  """

  @type checkpoint ::
          :postgres_head_hint
          | :control_ready
          | :live_frame
          | :command_result

  @type decision :: :deliver | :drop

  @callback decide(checkpoint(), map()) :: decision()
  @callback emit(checkpoint(), map(), pid(), term()) :: :ok

  @spec decide(checkpoint(), map()) :: decision()
  def decide(checkpoint, metadata \\ %{}) when is_atom(checkpoint) and is_map(metadata) do
    adapter = Application.get_env(:chalk_sync, :delivery_gate_adapter, __MODULE__.Immediate)

    case adapter.decide(checkpoint, metadata) do
      decision when decision in [:deliver, :drop] -> decision
      other -> raise ArgumentError, "invalid delivery-gate decision: #{inspect(other)}"
    end
  end

  @spec emit(checkpoint(), map(), pid(), term()) :: :ok
  def emit(checkpoint, metadata, recipient, message)
      when is_atom(checkpoint) and is_map(metadata) and is_pid(recipient) do
    adapter = Application.get_env(:chalk_sync, :delivery_gate_adapter, __MODULE__.Immediate)

    case adapter.emit(checkpoint, metadata, recipient, message) do
      :ok -> :ok
      other -> raise ArgumentError, "invalid delivery-gate emission: #{inspect(other)}"
    end
  end
end

defmodule ChalkSync.DeliveryGate.Immediate do
  @moduledoc false

  @behaviour ChalkSync.DeliveryGate

  @impl true
  def decide(_checkpoint, _metadata), do: :deliver

  @impl true
  def emit(_checkpoint, _metadata, recipient, message) do
    send(recipient, message)
    :ok
  end
end
