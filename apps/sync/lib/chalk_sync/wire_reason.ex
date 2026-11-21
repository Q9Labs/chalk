defmodule ChalkSync.WireReason do
  @moduledoc "The reason a rejected command carries on the wire in protocol v1."

  # A call whose policy turns recording off rejects start_recording with a reason protocol v1
  # does not carry. To the participant it is a capability the call does not grant, and an
  # unlisted reason would make the frame invalid and crash the socket.
  def to_wire(:recording_policy_disabled), do: "capability_denied"
  def to_wire(reason), do: Atom.to_string(reason)
end
