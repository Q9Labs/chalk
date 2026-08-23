defmodule ChalkSync.AdmissionTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Admission
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

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
    second = %{first | participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c24"}

    assert :ok = Admission.admit_reaction(admission, first, 1_000)
    assert {:error, :overloaded} = Admission.admit_reaction(admission, second, 1_001)
    assert :ok = Admission.admit_reaction(admission, second, 1_100)
    assert %{actors: 1, reservations: 1} = Admission.stats(admission)
  end

  test "shares cursor and chat budgets across calls for one participant generation" do
    admission =
      start_supervised!(
        {Admission,
         name: nil,
         cursor_rate_max: 2,
         cursor_window_ms: 100,
         chat_attempt_rate_max: 2,
         chat_attempt_window_ms: 100,
         chat_rate_max: 2,
         chat_window_ms: 100}
      )

    identity = identity()
    assert {:ok, cursor_budget} = Admission.open_whiteboard(admission, identity)

    assert :ok = Admission.admit_cursor(cursor_budget, identity, 1_000)
    assert :ok = Admission.admit_cursor(cursor_budget, identity, 1_001)
    assert {:error, :rate_limited} = Admission.admit_cursor(cursor_budget, identity, 1_002)
    assert :ok = Admission.admit_cursor(cursor_budget, identity, 1_100)

    assert :ok = Admission.admit_chat_attempt(admission, identity, 1_500)
    assert :ok = Admission.admit_chat_attempt(admission, identity, 1_501)
    assert {:error, :rate_limited} = Admission.admit_chat_attempt(admission, identity, 1_502)
    assert :ok = Admission.admit_chat_attempt(admission, identity, 1_600)

    assert :ok = Admission.admit_chat(admission, identity, 2_000)
    assert :ok = Admission.admit_chat(admission, identity, 2_001)
    assert {:error, :rate_limited} = Admission.admit_chat(admission, identity, 2_002)
    assert :ok = Admission.admit_chat(admission, identity, 2_100)
  end

  test "reclaims whiteboard socket slots when owners crash" do
    admission = start_supervised!({Admission, name: nil, whiteboard_socket_limit: 2})
    identity = identity()
    first_owner = spawn(fn -> Process.sleep(:infinity) end)
    second_owner = spawn(fn -> Process.sleep(:infinity) end)
    third_owner = spawn(fn -> Process.sleep(:infinity) end)

    assert {:ok, first_budget} = Admission.open_whiteboard(admission, identity, first_owner)
    assert {:ok, second_budget} = Admission.open_whiteboard(admission, identity, second_owner)
    assert first_budget == second_budget
    assert {:error, :overloaded} = Admission.open_whiteboard(admission, identity, third_owner)

    Process.exit(first_owner, :kill)

    assert eventually(fn ->
             match?({:ok, _budget}, Admission.open_whiteboard(admission, identity, third_owner))
           end)

    assert :ok = Admission.close_whiteboard(admission, identity, second_owner)
    Process.exit(second_owner, :kill)
    Process.exit(third_owner, :kill)
  end

  test "admits cursor traffic without entering the global admission mailbox" do
    admission =
      start_supervised!({Admission, name: nil, cursor_rate_max: 2, cursor_window_ms: 100})

    identity = identity()
    assert {:ok, cursor_budget} = Admission.open_whiteboard(admission, identity)
    :sys.suspend(admission)

    try do
      assert :ok = Admission.admit_cursor(cursor_budget, identity, 1_000)
      assert :ok = Admission.admit_cursor(cursor_budget, identity, 1_001)

      assert {:error, :rate_limited} =
               Admission.admit_cursor(cursor_budget, identity, 1_002)
    after
      :sys.resume(admission)
    end
  end

  defp eventually(assertion, attempts \\ 20)

  defp eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      true
    else
      Process.sleep(10)
      eventually(assertion, attempts - 1)
    end
  end

  defp eventually(_assertion, 0), do: false

  defp identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c20",
        space_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21",
        episode_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22"
      },
      participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23",
      participant_generation: 1
    }
  end
end
