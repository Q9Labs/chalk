defmodule ChalkSync.Transport.Socket.Presenting do
  @moduledoc "Per-socket presenting projection, ordered independently from Sync control."

  alias ChalkSync.Presenting.{Availability, Fanout, Protocol, Repository}
  alias ChalkSync.Transport.Socket.Frames

  @poll_ms 1_000

  def enter(%{presenting: true, identity: identity} = state) do
    if Availability.enabled?() do
      Fanout.join(identity.episode)
      Process.send_after(self(), :presenting_tick, @poll_ms)
    end

    state
  end

  def enter(state), do: state

  def initial_snapshot(state), do: refresh(state, true)

  def handle(frame, %{phase: :live} = state) do
    cond do
      not Availability.enabled?() -> disabled(state, frame)
      state.presenting -> handle_negotiated(frame, state)
      true -> Frames.protocol_error(:presenting_not_negotiated, state)
    end
  end

  def handle(_frame, state), do: Frames.protocol_error(:presenting_not_negotiated, state)

  defp handle_negotiated(frame, state) do
    case frame["type"] do
      "presenting_state_request" -> refresh(state, true)
      "presenting_command" -> command(frame, state)
    end
  end

  def tick(%{phase: :live, presenting: true} = state) do
    Process.send_after(self(), :presenting_tick, @poll_ms)
    refresh(state, false)
  end

  def tick(state), do: {:ok, state}

  def changed(%{phase: :live, presenting: true} = state), do: refresh(state, false)
  def changed(state), do: {:ok, state}

  defp command(frame, state) do
    now = System.monotonic_time(:millisecond)
    recent = Enum.filter(state.presenting_commands, &(now - &1 < 1_000))

    result =
      if length(recent) >= 12 do
        {:error, "rate_limited"}
      else
        Repository.command(state.identity, frame)
      end

    response = receipt(result)
    timestamps = if length(recent) < 12, do: [now | recent], else: recent

    push(%{state | presenting_commands: timestamps}, [
      %{
        "type" => "presenting_receipt",
        "operation_id" => frame["operation_id"],
        "result" => response
      }
    ])
  end

  defp receipt({:ok, result}), do: result

  defp receipt({:error, reason}) when is_binary(reason),
    do: %{"kind" => "rejected", "reason" => reason}

  defp receipt(_failure), do: %{"kind" => "rejected", "reason" => "invalid_state"}

  defp refresh(state, forced?) do
    if Availability.enabled?() do
      case Repository.read(state.identity) do
        {:ok, current} ->
          wire = wire_state(current)
          previous = state.presenting_state

          cond do
            forced? -> push(%{state | presenting_state: wire}, [state_frame(wire)])
            previous != wire -> push(%{state | presenting_state: wire}, [change_frame(wire)])
            true -> {:ok, state}
          end

        _failure ->
          {:ok, state}
      end
    else
      disabled(state)
    end
  end

  defp disabled(state, frame \\ nil) do
    frames =
      if Map.has_key?(state, :presenting_withdrawn) do
        []
      else
        [
          %{
            "type" => "presenting_state",
            "server_at_ms" => System.system_time(:millisecond),
            "enabled" => false,
            "state" => nil
          }
        ]
      end ++ disabled_receipt(frame)

    next =
      state
      |> Map.put(:presenting_withdrawn, true)
      |> Map.put(:presenting_state, nil)

    push(next, frames)
  end

  defp disabled_receipt(%{"type" => "presenting_command", "operation_id" => id}),
    do: [
      %{
        "type" => "presenting_receipt",
        "operation_id" => id,
        "result" => %{"kind" => "rejected", "reason" => "not_active"}
      }
    ]

  defp disabled_receipt(_frame), do: []

  defp wire_state(%{revision: revision, documents: documents}) do
    %{
      "revision" => revision,
      "documents" =>
        Enum.map(documents, fn document ->
          %{
            "document_id" => document.document_id,
            "presenter_id" => document.presenter_id,
            "page" => document.page,
            "zoom" => document.zoom,
            "started_at_ms" => document.started_at_ms
          }
        end)
    }
  end

  defp state_frame(state),
    do: %{
      "type" => "presenting_state",
      "server_at_ms" => System.system_time(:millisecond),
      "state" => state
    }

  defp change_frame(state),
    do: %{
      "type" => "presenting_changed",
      "server_at_ms" => System.system_time(:millisecond),
      "state" => state
    }

  defp push(state, frames) do
    Enum.each(frames, fn frame ->
      unless Protocol.valid_server_frame?(frame),
        do: raise(ArgumentError, "invalid presenting server frame")
    end)

    case frames do
      [] -> {:ok, state}
      _ -> {:push, Enum.map(frames, &{:text, Frames.encode_with_context(state, &1)}), state}
    end
  end
end
