defmodule ChalkSync.SyncBreakerV3.WireSdkPhase do
  @moduledoc false

  alias ChalkSync.Contract.GeneratedV3
  alias ChalkSync.ProtocolV3

  @name "wire_sdk"
  @default_seed 730_044
  @targets [
    {"set_hand_raised", %{"raised" => true}},
    {"set_display_name", %{"display_name" => "Wire name"}},
    {"set_admission_policy", %{"policy" => "approval"}},
    {"set_participant_role",
     %{"participant_session_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21", "role" => "cohost"}},
    {"transfer_host", %{"participant_session_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21"}}
  ]
  @forbidden_aliases [
    {"raise_hand", %{}},
    {"lower_hand", %{}},
    {"open_admission", %{}},
    {"promote_participant",
     %{"participant_session_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21"}},
    {"demote_participant", %{"participant_session_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21"}}
  ]
  @target_names Enum.map(@targets, &elem(&1, 0))
  @bounds %{
    "wire_targets" => 5,
    "wire_rejections" => 6,
    "sdk_rejections" => 6,
    "max_observations" => 32,
    "max_sdk_output_bytes" => 65_536
  }

  def run!(seed \\ @default_seed) when is_integer(seed) do
    wire = exercise_wire()
    sdk = exercise_sdk(seed)

    %{
      "name" => @name,
      "seed" => seed,
      "schedule" => [
        "declarative_target_wire",
        "relative_setter_and_remote_force_on_rejection",
        "sdk_ack_before_event",
        "sdk_event_before_ack",
        "sdk_duplicate_evidence",
        "sdk_rejection_rebase",
        "sdk_projection_exact_next_duplicate",
        "sdk_projection_gap_recovery",
        "sdk_restart_persisted_pending_target"
      ],
      "observations" => wire["observations"] ++ sdk["observations"],
      "evidence" => %{"wire" => wire["evidence"], "sdk" => sdk["evidence"]},
      "bounds" => Map.merge(@bounds, sdk["bounds"]),
      "invariants" => %{
        "all_five_declarative_targets_round_trip" =>
          wire["invariants"]["all_five_declarative_targets_round_trip"],
        "relative_setters_and_remote_force_on_are_rejected" =>
          wire["invariants"]["relative_setters_and_remote_force_on_are_rejected"] and
            sdk["invariants"]["forbidden_client_shapes_are_encoder_rejected"],
        "wire_and_sdk_reject_same_client_shapes" =>
          wire["evidence"]["invalid_shapes"]["labels"] ==
            sdk["evidence"]["forbidden_client_shapes"]["labels"],
        "sdk_schedule_and_invariants_hold" =>
          sdk["invariants"] |> Map.values() |> Enum.all?(& &1),
        "same_seed_sdk_map_is_normalized" => sdk["seed"] == seed
      },
      "verdict" =>
        if(wire["verdict"] == "pass" and sdk["verdict"] == "pass", do: "pass", else: "fail")
    }
  end

  def run!(_database_url, seed), do: run!(seed)

  defp exercise_wire do
    target_observations =
      Enum.with_index(@targets, 1)
      |> Enum.map(fn {{name, payload}, index} ->
        command_id = "wire-sdk-target-#{String.pad_leading(Integer.to_string(index), 3, "0")}"

        frame = %{
          "type" => "command",
          "command_id" => command_id,
          "name" => name,
          "payload" => payload
        }

        {:ok, {:command, decoded}} = ProtocolV3.decode(JSON.encode!(frame))

        ack = %{
          "type" => "ack",
          "command_id" => command_id,
          "delivery" => "original",
          "outcome" => "rejected",
          "reason" => "invalid_state"
        }

        encoded = ProtocolV3.encode!(ack)
        true = GeneratedV3.valid_server_frame?(JSON.decode!(encoded))

        %{
          "target" => name,
          "decoded_name" => decoded.name |> Atom.to_string(),
          "decoded_payload_keys" => decoded.payload |> Map.keys() |> Enum.sort(),
          "encoded_ack_bytes" => byte_size(encoded)
        }
      end)

    invalid = invalid_wire_shapes()

    %{
      "observations" => [
        %{
          "name" => "declarative_target_wire",
          "targets" => @target_names,
          "count" => length(target_observations)
        },
        %{
          "name" => "relative_setter_and_remote_force_on_rejection",
          "rejected_shapes" => invalid["labels"]
        }
      ],
      "evidence" => %{
        "declarative_targets" => target_observations,
        "invalid_shapes" => invalid
      },
      "invariants" => %{
        "all_five_declarative_targets_round_trip" =>
          Enum.map(target_observations, & &1["decoded_name"]) == @target_names and
            Enum.all?(target_observations, &(&1["encoded_ack_bytes"] > 0)),
        "relative_setters_and_remote_force_on_are_rejected" => invalid["all_decode_rejected"]
      },
      "verdict" => "pass"
    }
  end

  defp invalid_wire_shapes do
    relative_setters =
      Enum.with_index(@forbidden_aliases, 1)
      |> Enum.map(fn {{name, payload}, index} ->
        {name,
         %{
           "type" => "command",
           "command_id" =>
             "wire-sdk-invalid-#{String.pad_leading(Integer.to_string(index), 3, "0")}",
           "name" => name,
           "payload" => payload
         }}
      end)

    shapes =
      relative_setters ++
        [
          {"remote_force_on",
           %{
             "type" => "live_target",
             "operation_id" => "wire-sdk-invalid-006",
             "name" => "set_microphone_enabled",
             "enabled" => true,
             "participant_session_id" => "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21"
           }}
        ]

    results =
      Enum.map(shapes, fn {label, frame} ->
        decoded_rejected = match?({:error, _reason}, ProtocolV3.decode(JSON.encode!(frame)))

        %{
          "label" => label,
          "decode_rejected" => decoded_rejected
        }
      end)

    %{
      "labels" => Enum.map(results, & &1["label"]),
      "results" => results,
      "all_decode_rejected" => Enum.all?(results, & &1["decode_rejected"])
    }
  end

  defp exercise_sdk(seed) do
    script =
      Path.expand(
        "../../../../../sdks/typescript/client/scripts/sync-breaker-v3-wire-sdk.mjs",
        __DIR__
      )

    root = Path.expand("../../../../../", __DIR__)

    package = Path.expand("../../../../../sdks/typescript/client", __DIR__)

    {output, 0} =
      System.cmd(
        "pnpm",
        ["--dir", package, "exec", "tsx", script, Integer.to_string(seed)],
        cd: root,
        stderr_to_stdout: false
      )

    output = String.trim(output)
    true = byte_size(output) <= @bounds["max_sdk_output_bytes"]
    result = JSON.decode!(output)

    %{
      "seed" => result["seed"],
      "observations" => Enum.map(result["observations"], &normalize_sdk_observation/1),
      "evidence" => result["evidence"],
      "bounds" => result["bounds"],
      "invariants" => result["invariants"],
      "verdict" => result["verdict"]
    }
  end

  defp normalize_sdk_observation(observation) do
    observation
    |> Map.take([
      "name",
      "pending_at_ack",
      "pending_at_event",
      "duplicate_ack_count",
      "rejected",
      "control_revision",
      "sequence",
      "duplicate_accepted",
      "phase",
      "replayed_frame_count"
    ])
    |> Map.reject(fn {_key, value} -> is_nil(value) end)
  end
end
