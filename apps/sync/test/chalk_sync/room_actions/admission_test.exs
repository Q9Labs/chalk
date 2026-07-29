defmodule ChalkSync.RoomActions.AdmissionTest do
  use ExUnit.Case, async: true

  alias ChalkSync.RoomActions.Admission
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  test "accepts exactly the configured rate and resets after the fixed window" do
    admission =
      start_supervised!({Admission, name: nil, rate_max: 3, window_ms: 100})

    identity = identity()

    assert :ok = Admission.admit_reaction(admission, identity, 1_000)
    assert :ok = Admission.admit_reaction(admission, identity, 1_001)
    assert :ok = Admission.admit_reaction(admission, identity, 1_002)
    assert {:error, :rate_limited} = Admission.admit_reaction(admission, identity, 1_099)
    assert :ok = Admission.admit_reaction(admission, identity, 1_100)
    assert %{actors: 1, reservations: 3} = Admission.stats(admission)
  end

  test "bounds actor state and reclaims expired actors" do
    admission =
      start_supervised!({Admission, name: nil, actor_limit: 1, rate_max: 10, window_ms: 100})

    first = identity()
    second = %{first | participant_session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24"}

    assert :ok = Admission.admit_reaction(admission, first, 1_000)
    assert {:error, :overloaded} = Admission.admit_reaction(admission, second, 1_001)
    assert :ok = Admission.admit_reaction(admission, second, 1_100)
    assert %{actors: 1, reservations: 1} = Admission.stats(admission)
  end

  defp identity do
    %Identity{
      session: %SessionKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        room_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
      },
      participant_session_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_session_generation: 1
    }
  end
end
