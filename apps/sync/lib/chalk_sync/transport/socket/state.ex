defmodule ChalkSync.Transport.Socket.State do
  @moduledoc """
  The state of a v1 socket before its hello.
  """

  alias ChalkSync.Observability
  alias ChalkSync.Transport.CollaborationQueue, as: CollaborationQueue

  @hello_timeout_ms 5_000

  def awaiting_hello(opts, direct) do
    timer = Process.send_after(self(), :hello_timeout, @hello_timeout_ms)

    connection_attributes =
      opts |> Map.new() |> Map.get(:connection_attributes, %{close_code: nil})

    observability = opts |> Map.get(:observability) |> Observability.merge(nil)
    Observability.bind_logger(observability)

    observability =
      Observability.root(
        observability,
        "sync.websocket.handshake",
        Map.merge(connection_attributes, %{transport: "websocket", protocol: 1})
      )

    %{
      phase: :awaiting_hello,
      direct: direct,
      terminal: nil,
      hello_timer: timer,
      heartbeat_timer: nil,
      entry_timer: nil,
      entry_confirmation: Map.get(opts, :entry_confirmation, false),
      participant_self_identity: Map.get(opts, :participant_self_identity, false),
      media_off_reason: Map.get(opts, :media_off_reason, false),
      connection_quality: Map.get(opts, :connection_quality, false),
      participant_devices: Map.get(opts, :participant_devices, false),
      participant_device_admissions: Map.get(opts, :participant_device_admissions, false),
      requested_entry_generation: Map.get(opts, :entry_generation, :legacy),
      terminal_ack_timer: nil,
      terminal_head: nil,
      missed_heartbeats: 0,
      opened_at_ms: System.monotonic_time(:millisecond),
      last_heartbeat_at_ms: nil,
      identity: nil,
      coordinator: nil,
      commands: %{},
      collaboration_negotiated: false,
      collaboration_version: nil,
      collaboration_queue: CollaborationQueue.new(),
      connection_attributes: connection_attributes,
      observability: observability
    }
  end
end
