defmodule ChalkSync.Live.ExternalOperationReconcilerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Live.ExternalOperationReconciler

  test "requires provider-neutral observation before reporting success" do
    assert :pending =
             ExternalOperationReconciler.resolve(
               :mute_participant,
               :confirmed,
               :not_confirmed
             )

    assert :pending =
             ExternalOperationReconciler.resolve(
               :stop_participant_camera,
               :satisfied,
               :unavailable
             )

    assert :applied =
             ExternalOperationReconciler.resolve(
               :stop_participant_screen_share,
               :confirmed,
               :confirmed
             )

    assert :applied =
             ExternalOperationReconciler.resolve(:remove_participant, :satisfied, :confirmed)
  end

  test "keeps ambiguous and retryable outcomes pending and preserves terminal failure" do
    assert :pending =
             ExternalOperationReconciler.resolve(:remove_participant, :ambiguous, :confirmed)

    assert :pending =
             ExternalOperationReconciler.resolve(
               :mute_participant,
               {:retryable_failure, :timeout},
               :confirmed
             )

    assert {:failed, :permission_denied} =
             ExternalOperationReconciler.resolve(
               :stop_participant_camera,
               {:terminal_failure, :permission_denied},
               :not_confirmed
             )
  end
end
