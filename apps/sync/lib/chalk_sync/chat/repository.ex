defmodule ChalkSync.Chat.Repository do
  @moduledoc """
  Durable chat and authoritative participant-membership boundary.

  Implementations allocate a contiguous sequence and persist the message in one
  transaction. Duplicate client message IDs with the same fingerprint return
  the original message; a changed payload returns a conflict.
  """

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  @typedoc "A server-stamped durable chat message."
  @type message :: %{
          message_id: String.t(),
          client_message_id: String.t(),
          sequence: String.t(),
          participant_id: String.t(),
          display_name: String.t(),
          text: String.t(),
          attachments: [attachment()],
          created_at: String.t()
        }

  @type attachment :: %{
          attachment_id: String.t(),
          file_name: String.t(),
          mime_type: String.t(),
          byte_length: pos_integer()
        }

  @type read_receipt :: %{
          participant_id: String.t(),
          participant_generation: pos_integer(),
          sequence: String.t(),
          read_at: String.t()
        }

  @typedoc "The retained range for one Episode chat stream."
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
          | :rate_limited
          | :overloaded
          | :episode_ended
          | :participant_stale
          | :client_message_id_conflict
          | :attachment_not_found
          | :attachment_not_ready
          | :attachment_already_claimed
          | :attachment_quota_exceeded
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
              text: String.t(),
              attachment_ids: [String.t()]
            }) ::
              {:ok, %{outcome: :committed | :duplicate, message: message()}}
              | {:error, error_code()}

  @callback append(
              Identity.t(),
              %{
                client_message_id: String.t(),
                text: String.t(),
                attachment_ids: [String.t()]
              },
              (-> :ok | {:error, :rate_limited | :overloaded})
            ) ::
              {:ok, %{outcome: :committed | :duplicate, message: message()}}
              | {:error, error_code()}

  @callback head(EpisodeKey.t()) :: {:ok, head()} | {:error, error_code()}

  @callback read_receipts(EpisodeKey.t()) ::
              {:ok, [read_receipt()]} | {:error, error_code()}

  @callback mark_read(Identity.t(), String.t()) ::
              {:ok, %{outcome: :advanced | :unchanged, receipt: read_receipt()}}
              | {:error, error_code()}

  @callback read_page(
              EpisodeKey.t(),
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
