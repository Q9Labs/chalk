defmodule ChalkSync.Stateholder.MemoryExternalTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.Operation

  @tenant "11111111-1111-4111-8111-111111111111"
  @space "22222222-2222-4222-8222-222222222222"
  @episode_id "33333333-3333-4333-8333-333333333333"
  @host "55555555-5555-4555-8555-555555555555"
  @guest "66666666-6666-4666-8666-666666666666"

  setup do
    Memory.reset()
    episode = %EpisodeKey{tenant_id: @tenant, space_id: @space, episode_id: @episode_id}

    :ok =
      Memory.seed_episode(episode, [
        %{
          id: @host,
          generation: 1,
          display_name: "Host",
          role: "owner",
          capabilities: ["manageAdmission", "assignRoles", "removeParticipant", "sendChat"]
        },
        %{
          id: @guest,
          generation: 7,
          display_name: "Guest",
          role: "observer",
          capabilities: ["subscribe", "sendReaction"]
        }
      ])

    identity = %Identity{
      episode: episode,
      participant_id: @host,
      participant_generation: 1
    }

    %{episode: episode, identity: identity}
  end

  test "begins, claims, reads, and finalizes an authorized external operation", context do
    {:ok, operation} =
      Operation.new("mute_operation_01", :mute_participant, %{
        "participantId" => @guest
      })

    assert {:ok, %{result: :pending, delivery: :original} = pending} =
             Memory.begin_operation(context.identity, operation)

    assert {:ok, [{episode, claimed}]} = Memory.claim_operations(1)
    assert episode == context.episode
    assert claimed.target_participant_generation == 7

    assert {:ok, ^claimed} =
             Memory.read_operation(context.episode, pending.external_operation_id)

    assert {:ok, %{result: :applied, revision: 3}} =
             Memory.finalize_operation(context.episode, pending.external_operation_id, {
               :applied,
               :participant_microphone_stopped,
               %{"participant_id" => @guest}
             })

    assert {:ok, []} = Memory.claim_operations(1)
  end

  test "deduplicates request keys and rejects changed fingerprints", context do
    {:ok, first} =
      Operation.new("external_same_001", :remove_participant, %{
        "participantId" => @guest
      })

    {:ok, changed} =
      Operation.new("external_same_001", :remove_participant, %{
        "participantId" => @host
      })

    assert {:ok, %{result: :pending}} = Memory.begin_operation(context.identity, first)

    assert {:ok, %{result: :pending, delivery: :duplicate}} =
             Memory.begin_operation(context.identity, first)

    assert {:ok, %{result: :command_id_conflict}} =
             Memory.begin_operation(context.identity, changed)
  end

  test "does not let a participant authorize moderator work from identity claims", context do
    %Identity{} = host_identity = context.identity

    guest = %{
      host_identity
      | participant_id: @guest,
        participant_generation: 7,
        capabilities: ["muteOthers"]
    }

    {:ok, operation} =
      Operation.new("unauthorized_op_01", :mute_participant, %{
        "participantId" => @host
      })

    assert {:ok, %{result: :rejected, reason: :invalid_state}} =
             Memory.begin_operation(guest, operation)
  end

  test "reads current role-derived participant authority with an optional generation fence",
       context do
    assert {:ok,
            %{
              participant_id: @host,
              generation: 1,
              role: "owner",
              capabilities: capabilities
            }} = Memory.participant_authority(context.episode, @host, 1)

    assert "muteOthers" in capabilities

    assert {:ok, %{participant_id: @guest, generation: 7, role: "observer"}} =
             Memory.participant_authority(context.episode, @guest, nil)

    assert {:error, :stale_participant_generation} =
             Memory.participant_authority(context.episode, @guest, 8)
  end

  test "expires an admission only through a durable internal operation fact", context do
    request_id = "77777777-7777-4777-8777-777777777777"

    :ok =
      Memory.seed_admission_request(context.episode, %{
        "admission_request_id" => request_id,
        "participant_id" => "88888888-8888-4888-8888-888888888888",
        "display_name" => "Waiting",
        "role" => "observer",
        "expires_at_ms" => 50_000
      })

    {:ok, operation} =
      Operation.new("expire_request_001", :admission_request_expired, %{
        "admissionRequestId" => request_id
      })

    assert {:ok, %{result: :pending} = pending} =
             Memory.begin_internal_operation(context.episode, operation)

    assert {:ok, %{result: :applied, revision: 4}} =
             Memory.finalize_operation(context.episode, pending.external_operation_id, {
               :applied,
               :admission_expired,
               %{"admission_request_id" => request_id}
             })

    assert {:ok, %{result: :applied, delivery: :duplicate, revision: 4}} =
             Memory.finalize_operation(context.episode, pending.external_operation_id, {
               :applied,
               :admission_expired,
               %{"admission_request_id" => request_id}
             })
  end
end
