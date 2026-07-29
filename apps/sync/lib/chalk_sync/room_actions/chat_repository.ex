defmodule ChalkSync.RoomActions.ChatRepository do
  @moduledoc """
  Durable chat and authoritative participant-membership boundary.

  Implementations allocate a contiguous sequence and persist the message in one
  transaction. Duplicate client message IDs with the same fingerprint return
  the original message; a changed payload returns a conflict.
  """

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  @typedoc "A server-stamped durable chat message."
  @type message :: %{
          message_id: String.t(),
          client_message_id: String.t(),
          sequence: String.t(),
          participant_session_id: String.t(),
          display_name: String.t(),
          text: String.t(),
          created_at: String.t()
        }

  @typedoc "The retained range for one Session chat stream."
  @type head :: %{
          head_sequence: String.t() | nil,
          retained_floor_sequence: String.t() | nil
        }

  @typedoc "A bounded page in chronological order."
  @type page :: %{
          messages: [message()],
          has_more: boolean(),
          head_sequence: String.t() | nil,
          retained_floor_sequence: String.t() | nil
        }

  @type direction :: :older | :newer
  @type error_code ::
          :capability_denied
          | :invalid_payload
          | :overloaded
          | :session_ended
          | :participant_stale
          | :client_message_id_conflict
          | :dependency_unavailable

  @callback authorize(Identity.t(), String.t() | nil) ::
              {:ok, %{display_name: String.t()}} | {:error, error_code()}

  @callback participant_capabilities(Identity.t()) ::
              {:ok,
               %{
                 capabilities: [String.t()],
                 participant_capabilities: %{String.t() => [String.t()]}
               }}
              | {:error, error_code()}

  @callback append(Identity.t(), %{
              client_message_id: String.t(),
              text: String.t()
            }) ::
              {:ok, %{outcome: :committed | :duplicate, message: message()}}
              | {:error, error_code()}

  @callback head(SessionKey.t()) :: {:ok, head()} | {:error, error_code()}

  @callback read_page(
              SessionKey.t(),
              %{
                direction: direction(),
                cursor_sequence: String.t() | nil,
                limit: pos_integer()
              }
            ) ::
              {:ok, page()}
              | {:cursor_reset, String.t()}
              | {:error, error_code()}
end
