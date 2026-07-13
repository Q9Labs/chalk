defmodule ChalkSync.Live.ExternalOperationReconciler do
  @moduledoc "Provider-neutral confirmation boundary for external media operations."

  @type operation ::
          :mute_participant
          | :stop_participant_camera
          | :stop_participant_screen_share
          | :remove_participant
  @type provider_outcome :: ChalkSync.MediaPlane.outcome()
  @type confirmation :: :confirmed | :not_confirmed | :unavailable
  @type resolution :: :applied | :pending | {:failed, atom()}

  @spec resolve(operation(), provider_outcome(), confirmation()) :: resolution()
  def resolve(operation, outcome, confirmation)

  def resolve(operation, outcome, :confirmed)
      when operation in [
             :mute_participant,
             :stop_participant_camera,
             :stop_participant_screen_share,
             :remove_participant
           ] and outcome in [:confirmed, :satisfied],
      do: :applied

  def resolve(_operation, {:terminal_failure, reason}, _confirmation), do: {:failed, reason}
  def resolve(_operation, _outcome, _confirmation), do: :pending
end
