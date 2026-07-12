defmodule ChalkSync.Stateholder.MemorySemanticTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.SessionKey

  setup do
    Memory.reset()
    :ok
  end

  test "keeps committed and rejected receipts stable beyond the former cache limit" do
    {session, identity} = seed_identity("session-a")
    command = command("original_command", :raise_hand)

    assert {:ok, %{result: :committed, revision: 2} = committed} =
             Memory.decide_command(identity, command)

    Enum.each(1..300, fn index ->
      rejected =
        command("filler_command_#{String.pad_leading(to_string(index), 4, "0")}", :raise_hand)

      assert {:ok, %{result: :rejected, reason: :invalid_state}} =
               Memory.decide_command(identity, rejected)
    end)

    assert {:ok, duplicate} = Memory.decide_command(identity, command)
    assert duplicate.result == :duplicate
    assert duplicate.revision == committed.revision
    assert duplicate.event_id == committed.event_id

    assert {:ok, recovery} = Memory.recover(session, nil)
    assert recovery.head.revision == 2
  end

  test "derives command ID conflicts without changing the original receipt" do
    {_session, identity} = seed_identity("session-a")
    original = command("same_command_id_1", :raise_hand)
    changed = command("same_command_id_1", :lower_hand)

    assert {:ok, %{result: :committed}} = Memory.decide_command(identity, original)

    assert {:ok, %{result: :command_id_conflict, reason: :command_id_conflict}} =
             Memory.decide_command(identity, changed)

    assert {:ok, %{result: :duplicate}} = Memory.resolve_receipt(identity, original)
  end

  test "receipt lookup precedes current generation validation" do
    {session, identity} = seed_identity("session-a")
    command = command("rotation_retry_01", :raise_hand)

    assert {:ok, %{result: :committed, revision: 2}} = Memory.decide_command(identity, command)

    rotated = %{identity | participant_session_generation: 2}
    assert {:ok, %{result: :duplicate, revision: 2}} = Memory.decide_command(rotated, command)

    assert {:ok, %{result: :rejected, reason: :stale_participant_generation}} =
             Memory.decide_command(rotated, command("rotation_new_id1", :lower_hand))

    assert {:ok, recovery} = Memory.recover(session, nil)
    assert recovery.head.revision == 2
  end

  test "isolates Sessions that share tenant and Room context" do
    {_first_session, first_identity} = seed_identity("session-a")
    {second_session, second_identity} = seed_identity("session-b")

    assert {:ok, %{result: :committed, revision: 2}} =
             Memory.decide_command(first_identity, command("isolated_command", :raise_hand))

    assert {:ok, recovery} = Memory.recover(second_session, nil)
    assert recovery.head.revision == 1
    refute recovery.snapshot["participants"] |> hd() |> Map.fetch!("hand_raised")

    assert {:ok, %{result: :committed, revision: 2}} =
             Memory.decide_command(second_identity, command("isolated_command", :raise_hand))
  end

  test "returns up-to-date only when revision, schema, and digest all match" do
    {session, _identity} = seed_identity("session-a")
    assert {:ok, snapshot} = Memory.recover(session, nil)

    assert {:ok, up_to_date} = Memory.recover(session, snapshot.head)
    assert up_to_date.mode == :up_to_date

    corrupted = %{snapshot.head | digest: :crypto.strong_rand_bytes(32)}
    assert {:ok, replacement} = Memory.recover(session, corrupted)
    assert replacement.mode == :snapshot
  end

  test "replays only from a historical cursor with the stored schema and digest" do
    {session, identity} = seed_identity("session-a")
    assert {:ok, %{head: cursor}} = Memory.recover(session, nil)

    assert {:ok, %{result: :committed, revision: 2}} =
             Memory.decide_command(identity, command("historical_cursor", :raise_hand))

    assert {:ok, %{mode: :replay, replay_cursor: 1}} = Memory.recover(session, cursor)

    assert {:ok, %{mode: :snapshot}} =
             Memory.recover(session, %{cursor | digest: :crypto.strong_rand_bytes(32)})

    assert {:ok, %{mode: :snapshot}} =
             Memory.recover(session, %{
               cursor
               | state_schema_version: cursor.state_schema_version + 1
             })
  end

  defp seed_identity(session_id) do
    session = %SessionKey{
      tenant_id: "11111111-1111-4111-8111-111111111111",
      room_id: "22222222-2222-4222-8222-222222222222",
      session_id: session_uuid(session_id)
    }

    participant = %{
      id: "55555555-5555-4555-8555-555555555555",
      generation: 1,
      display_name: "Ada",
      capabilities: ["control:hand"]
    }

    :ok = Memory.seed_session(session, [participant])

    identity = %Identity{
      session: session,
      participant_session_id: participant.id,
      participant_session_generation: participant.generation,
      capabilities: participant.capabilities
    }

    {session, identity}
  end

  defp session_uuid("session-a"), do: "33333333-3333-4333-8333-333333333333"
  defp session_uuid("session-b"), do: "44444444-4444-4444-8444-444444444444"

  defp command(id, name) do
    {:ok, command} = Command.new(String.pad_trailing(id, 16, "_"), name, %{})
    command
  end
end
