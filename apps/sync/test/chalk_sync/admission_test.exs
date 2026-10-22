defmodule ChalkSync.AdmissionTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Admission
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  test "an expired slot that arrived out of order still frees the window" do
    admission =
      start_supervised!({Admission, name: nil, rate_max: [reaction: 2], window_ms: 10_000})

    identity = identity()

    assert :ok = Admission.admit_reaction(admission, identity, 20_000)
    # A caller that read the clock earlier reaches the server second.
    assert :ok = Admission.admit_reaction(admission, identity, 5_000)
    assert :ok = Admission.admit_reaction(admission, identity, 25_000)
  end

  test "chat and reactions use separate windows" do
    admission = start_supervised!({Admission, name: nil, rate_max: [reaction: 1, chat: 1]})
    identity = identity()

    assert :ok = Admission.admit_reaction(admission, identity, 0)
    assert :ok = Admission.admit(admission, :chat, identity, 0)
    assert {:error, :rate_limited} = Admission.admit(admission, :chat, identity, 1)
  end

  test "chat senders do not use up the actor budget for reactions" do
    admission = start_supervised!({Admission, name: nil, actor_limit: 1})

    assert :ok = Admission.admit(admission, :chat, identity(), 0)
    assert {:error, :overloaded} = Admission.admit(admission, :chat, other_identity(), 0)
    assert :ok = Admission.admit_reaction(admission, other_identity(), 0)
  end

  defp other_identity, do: %{identity() | participant_id: "00000000-0000-4000-8000-000000000005"}

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
