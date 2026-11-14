defmodule ChalkSync.Stateholder.Postgres.Lifecycle.AutomaticRecording do
  @moduledoc """
  Accepts the automatic recording start that an Episode policy asks for when its first Participant joins.
  """

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.UUID

  @automatic_recording_policy_snapshot_version 2
  @uuid_namespace_dns <<0x6B, 0xA7, 0xB8, 0x10, 0x9D, 0xAD, 0x11, 0xD1, 0x80, 0xB4, 0x00, 0xC0,
                        0x4F, 0xD4, 0x30, 0xC8>>

  def maybe_accept_automatic_recording(
        connection,
        episode,
        %{name: "participant_joined"} = intent,
        policy,
        state
      ) do
    if automatic_recording_policy?(policy) do
      operation = automatic_recording_operation(episode)

      case ExternalOperationPlanner.fetch_internal_operation(connection, episode, operation) do
        {:ok, existing} when existing.request_fingerprint == operation.fingerprint ->
          :ok

        {:ok, _conflicting} ->
          Postgrex.rollback(connection, {:error, :invalid_state})

        :not_found ->
          checkpoint_automatic_recording_acceptance(
            connection,
            episode,
            intent,
            operation,
            policy,
            state
          )
      end
    else
      :ok
    end
  end

  def maybe_accept_automatic_recording(
        _connection,
        _episode,
        _intent,
        _policy,
        _state
      ),
      do: :ok

  defp checkpoint_automatic_recording_acceptance(
         connection,
         episode,
         intent,
         operation,
         policy,
         state
       ) do
    case accept_automatic_recording(connection, episode, operation, policy, state) do
      %OperationDecision{} ->
        FaultHooks.lifecycle(:after_automatic_recording_acceptance, episode, intent.id)

      :ok ->
        :ok
    end
  end

  defp accept_automatic_recording(connection, episode, operation, policy, state) do
    case ExternalOperationPlanner.persist_new_internal_operation(
           connection,
           episode,
           operation,
           policy,
           state
         ) do
      %OperationDecision{} = decision ->
        decision

      {:error, :recording_in_progress} ->
        :ok

      {:error, :overloaded} ->
        Postgrex.rollback(connection, {:retryable, :overloaded})

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp automatic_recording_policy?(%{
         status: "active",
         artifact_policy: %{
           "schema_version" => "episode_config.v2",
           "recording" => %{"mode" => "automatic"}
         }
       }),
       do: true

  defp automatic_recording_policy?(_policy), do: false

  defp automatic_recording_operation(%EpisodeKey{} = episode) do
    request_key = "automatic_recording_" <> String.replace(episode.episode_id, "-", "")

    {:ok, operation} =
      Operation.system_recording_start(
        request_key,
        automatic_recording_id(episode),
        @automatic_recording_policy_snapshot_version
      )

    operation
  end

  defp automatic_recording_id(%EpisodeKey{episode_id: episode_id}) do
    <<a::48, _version::4, b::12, _variant::2, c::62, _rest::binary>> =
      :crypto.hash(:sha, [@uuid_namespace_dns, "chalk-sync/automatic-recording/", episode_id])

    UUID.load!(<<a::48, 5::4, b::12, 2::2, c::62>>)
  end
end
