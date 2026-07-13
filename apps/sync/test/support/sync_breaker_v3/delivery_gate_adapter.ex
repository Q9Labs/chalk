defmodule ChalkSync.SyncBreakerV3.DeliveryGateAdapter do
  @moduledoc false

  use GenServer

  @behaviour ChalkSync.DeliveryGate

  @max_actions 64
  @max_held 64
  @max_observations 256

  def start_link(actions, options \\ []) when is_list(actions) do
    if length(actions) <= @max_actions do
      GenServer.start_link(__MODULE__, {actions, Keyword.get(options, :controller, self())},
        name: __MODULE__
      )
    else
      {:error, :action_limit}
    end
  end

  def stop do
    if Process.whereis(__MODULE__), do: GenServer.stop(__MODULE__)
  end

  def observations, do: GenServer.call(__MODULE__, :observations)
  def held_count, do: GenServer.call(__MODULE__, :held_count)
  def release(tag), do: GenServer.call(__MODULE__, {:release, tag})

  def await(index, timeout \\ 2_000) do
    receive do
      {:delivery_gate_observed, ^index, observation} -> {:ok, observation}
    after
      timeout -> {:error, :timeout}
    end
  end

  def await_action(checkpoint, action, timeout \\ 2_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    await_action_until(checkpoint, action, deadline)
  end

  @impl true
  def decide(checkpoint, metadata) do
    if Process.whereis(__MODULE__),
      do: GenServer.call(__MODULE__, {:decide, checkpoint, metadata}),
      else: :deliver
  end

  @impl true
  def emit(checkpoint, metadata, recipient, message) do
    if Process.whereis(__MODULE__) do
      GenServer.call(__MODULE__, {:emit, checkpoint, metadata, recipient, message})
    else
      send(recipient, message)
      :ok
    end
  end

  @impl true
  def init({actions, controller}) do
    {:ok, %{actions: actions, controller: controller, held: %{}, observations: []}}
  end

  @impl true
  def handle_call(:observations, _from, state),
    do: {:reply, Enum.reverse(state.observations), state}

  def handle_call(:held_count, _from, state), do: {:reply, held_size(state.held), state}

  def handle_call({:release, tag}, _from, state) do
    {emissions, held} = Map.pop(state.held, tag, [])
    Enum.each(Enum.reverse(emissions), fn {recipient, message} -> send(recipient, message) end)
    {:reply, {:ok, length(emissions)}, %{state | held: held}}
  end

  def handle_call({:decide, checkpoint, metadata}, _from, state) do
    {action, actions} = take_action(state.actions, checkpoint, metadata, :deliver)
    decision = if action == :drop, do: :drop, else: :deliver
    state = observe(%{state | actions: actions}, checkpoint, action, metadata)
    {:reply, decision, state}
  end

  def handle_call({:emit, checkpoint, metadata, recipient, message}, _from, state) do
    {action, actions} = take_action(state.actions, checkpoint, metadata, :deliver)
    state = %{state | actions: actions}

    state =
      case action do
        :deliver ->
          send(recipient, message)
          state

        :drop ->
          state

        :duplicate ->
          send(recipient, message)
          send(recipient, message)
          state

        {:hold, tag} ->
          if held_size(state.held) >= @max_held, do: raise("delivery gate held-emission limit")
          update_in(state, [:held, tag], &[{recipient, message} | &1 || []])
      end

    {:reply, :ok, observe(state, checkpoint, action, metadata)}
  end

  defp take_action([{checkpoint, action} | rest], checkpoint, _metadata, _default),
    do: {action, rest}

  defp take_action([{checkpoint, expected, action} | rest], checkpoint, metadata, _default)
       when is_map(expected) do
    if Map.take(metadata, Map.keys(expected)) == expected,
      do: {action, rest},
      else: {:deliver, [{checkpoint, expected, action} | rest]}
  end

  defp take_action(actions, _checkpoint, _metadata, default), do: {default, actions}

  defp await_action_until(checkpoint, action, deadline) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:delivery_gate_observed, _index, %{checkpoint: ^checkpoint, action: ^action} = observation} ->
        {:ok, observation}

      {:delivery_gate_observed, _index, _observation} ->
        await_action_until(checkpoint, action, deadline)
    after
      timeout -> {:error, :timeout}
    end
  end

  defp observe(state, checkpoint, action, metadata) do
    index = length(state.observations) + 1
    observation = %{index: index, checkpoint: checkpoint, action: action, metadata: metadata}
    send(state.controller, {:delivery_gate_observed, index, observation})
    %{state | observations: Enum.take([observation | state.observations], @max_observations)}
  end

  defp held_size(held), do: held |> Map.values() |> Enum.map(&length/1) |> Enum.sum()
end
