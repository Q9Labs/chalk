defmodule ChalkSync.Stateholder.Recovery do
  @moduledoc "Consistent authoritative recovery read for one Session."

  @enforce_keys [:mode, :head, :snapshot, :events]
  defstruct [:mode, :head, :snapshot, :events, :replay_cursor, :terminal_reason]

  @type head :: %{
          revision: non_neg_integer(),
          state_schema_version: pos_integer(),
          digest: binary()
        }
  @type t :: %__MODULE__{
          mode: :snapshot | :replay | :up_to_date | :terminal,
          head: head(),
          snapshot: map() | nil,
          events: [map()],
          replay_cursor: non_neg_integer() | nil,
          terminal_reason:
            :session_ended | :participant_inactive | :stale_participant_generation | nil
        }
end
