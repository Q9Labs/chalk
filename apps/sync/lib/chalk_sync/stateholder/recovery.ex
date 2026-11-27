defmodule ChalkSync.Stateholder.Recovery do
  @moduledoc "Consistent authoritative recovery read for one Episode."

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
            :episode_ended | :participant_inactive | :stale_participant_generation | nil
        }

  @spec replay_if_ended(t() | term(), String.t()) :: t() | term()
  def replay_if_ended(%__MODULE__{replay_cursor: revision} = recovery, "ended")
      when is_integer(revision),
      do: %{recovery | mode: :replay, terminal_reason: :episode_ended}

  def replay_if_ended(recovery, _status), do: recovery
end
