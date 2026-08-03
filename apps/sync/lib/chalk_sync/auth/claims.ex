defmodule ChalkSync.Auth.Claims do
  @moduledoc """
  Verified participant claims — the token-asserted admission identity primitive.

  The token carries the role and capability snapshot for the participant.
  Current authorization is still checked against the Stateholder.
  """

  @enforce_keys [:tenant_id, :space_id]
  defstruct [
    :tenant_id,
    :space_id,
    :participant_id,
    :episode_id,
    :participant_generation,
    :admission_lifecycle_intent_id,
    :issued_at,
    :expires_at,
    :role,
    display_name: "Guest",
    capabilities: []
  ]

  @type t :: %__MODULE__{
          tenant_id: String.t(),
          space_id: String.t(),
          participant_id: String.t() | nil,
          episode_id: String.t() | nil,
          participant_generation: pos_integer() | nil,
          admission_lifecycle_intent_id: String.t() | nil,
          issued_at: integer() | nil,
          expires_at: integer() | nil,
          role: String.t() | nil,
          display_name: String.t(),
          capabilities: [String.t()]
        }

  @capabilities ~w(publishAudio publishVideo publishScreen subscribe raiseHand renameSelf sendChat sendReaction drawWhiteboard manageWhiteboard manageAdmission assignRoles muteOthers stopVideoOthers stopScreenOthers requestMediaOthers removeParticipant manageRecording startEpisode extendEpisode endEpisode manageMembers clearSpaceContent)

  @spec valid_authorization?(term(), term()) :: boolean()
  def valid_authorization?(role, capabilities) do
    is_binary(role) and byte_size(role) in 1..64 and role == String.trim(role) and
      is_list(capabilities) and length(capabilities) <= 23 and
      Enum.uniq(capabilities) == capabilities and Enum.all?(capabilities, &(&1 in @capabilities))
  end
end
