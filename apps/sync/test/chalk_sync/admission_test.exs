defmodule ChalkSync.AdmissionTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Admission
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  test "an expired slot that arrived out of order still frees the window" do
    admission = start_supervised!({Admission, name: nil, rate_max: 2, window_ms: 10_000})
    identity = identity()

    assert :ok = Admission.admit_reaction(admission, identity, 20_000)
    # A caller that read the clock earlier reaches the server second.
    assert :ok = Admission.admit_reaction(admission, identity, 5_000)
    assert :ok = Admission.admit_reaction(admission, identity, 25_000)
  end

  test "chat and reactions use separate windows" do
    admission = start_supervised!({Admission, name: nil, rate_max: 1, chat_rate_max: 1})
    identity = identity()

    assert :ok = Admission.admit_reaction(admission, identity, 0)
    assert :ok = Admission.admit_chat(admission, identity, 0)
    assert {:error, :rate_limited} = Admission.admit_chat(admission, identity, 1)
  end

  defp identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "00000000-0000-4000-8000-000000000001",
        space_id: "00000000-0000-4000-8000-000000000002",
        episode_id: "00000000-0000-4000-8000-000000000003"
      },
      participant_id: "00000000-0000-4000-8000-000000000004",
      participant_generation: 1
    }
  end
end
