defmodule ChalkSync.SyncBreaker.Checker.Failure do
  @moduledoc "A structured invariant failure suitable for a replay artifact."

  @enforce_keys [:invariant, :message]
  defstruct [:invariant, :message, :seq, :record, details: %{}]

  @type t :: %__MODULE__{
          invariant: atom(),
          message: String.t(),
          seq: pos_integer() | nil,
          record: term(),
          details: map()
        }

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = failure) do
    %{
      "invariant" => Atom.to_string(failure.invariant),
      "message" => failure.message,
      "seq" => failure.seq,
      "details" => failure.details
    }
  end
end
