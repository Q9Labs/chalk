defmodule ChalkSync.Auth.Claims do
  @moduledoc """
  Verified participant claims — the token-asserted admission identity primitive.

  Protocol v1 carries its legacy capability list. Protocol v3 carries only a
  bounded initial-role envelope; current authorization always comes from the
  Stateholder rather than either token shape.
  """

  @enforce_keys [:tenant_id, :room_id]
  defstruct [
    :tenant_id,
    :room_id,
    :participant_id,
    :session_id,
    :participant_session_id,
    :participant_session_generation,
    :admission_lifecycle_intent_id,
    :issued_at,
    :expires_at,
    :initial_role,
    display_name: "Guest",
    eligible_roles: [],
    capabilities: []
  ]

  @type t :: %__MODULE__{
          tenant_id: String.t(),
          room_id: String.t(),
          participant_id: String.t() | nil,
          session_id: String.t() | nil,
          participant_session_id: String.t() | nil,
          participant_session_generation: pos_integer() | nil,
          admission_lifecycle_intent_id: String.t() | nil,
          issued_at: integer() | nil,
          expires_at: integer() | nil,
          initial_role: String.t() | nil,
          display_name: String.t(),
          eligible_roles: [String.t()],
          capabilities: [String.t()]
        }

  @roles ["host", "cohost", "participant"]

  @spec valid_role_envelope?(term(), term()) :: boolean()
  def valid_role_envelope?(initial_role, eligible_roles) do
    initial_role in @roles and is_list(eligible_roles) and
      length(eligible_roles) in 1..length(@roles) and
      Enum.all?(eligible_roles, &(&1 in @roles)) and
      Enum.uniq(eligible_roles) == eligible_roles and
      initial_role in eligible_roles and
      (initial_role != "host" or "cohost" in eligible_roles)
  end
end
