defmodule ChalkSync.DevTools.TraceSocket do
  @moduledoc false

  @behaviour WebSock

  alias ChalkSync.DevTools.TraceHub

  @impl true
  def init(_opts) do
    :ok = TraceHub.subscribe()
    {:ok, %{}}
  end

  @impl true
  def handle_in({_payload, _opts}, state), do: {:ok, state}

  @impl true
  def handle_info({:trace_history, events}, state) do
    {:push, {:text, JSON.encode!(%{"type" => "history", "events" => events})}, state}
  end

  def handle_info({:trace_event, event}, state) do
    {:push, {:text, JSON.encode!(%{"type" => "trace", "event" => event})}, state}
  end
end
