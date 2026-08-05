defmodule ChalkSync.SyncBreakerV1.Oracle do
  @moduledoc false

  alias ChalkSync.Episodes.Reducer

  @event_names ~w(
    episode_started participant_joined participant_left hand_raised hand_lowered
    participant_display_name_changed admission_policy_changed deadline_changed
    admission_requested admission_denied admission_expired participant_microphone_stopped
    participant_camera_stopped participant_screen_share_stopped recording_status_changed
    role_assigned episode_ended
  )

  def event_names, do: @event_names

  def fold(episode_id, policy, events) do
    Enum.reduce(events, Reducer.new(episode_id, policy), &advance/2)
  end

  def verify!(episode_id, policy, events, recovery) do
    state = fold(episode_id, policy, events)
    snapshot = Reducer.snapshot(state)
    digest = Reducer.digest(state)

    verified_state =
      Enum.reduce(events, Reducer.new(episode_id, policy), fn event, current ->
        next = advance(event, current)

        unless Reducer.digest(next) == field(event, :resulting_state_digest) do
          raise "independent digest chain diverged from PostgreSQL events"
        end

        next
      end)

    unless verified_state == state and state.revision == recovery.head.revision and
             digest == recovery.head.digest and snapshot == recovery.snapshot do
      raise "independent fold diverged from PostgreSQL authority"
    end

    Map.merge(state, %{digest: digest, snapshot: snapshot})
  end

  def snapshot(state), do: Reducer.snapshot(state)
  def digest(state), do: Reducer.digest(state)

  defp advance(event, state) do
    name = field(event, :name)
    base_revision = field(event, :base_revision)
    revision = field(event, :revision)
    payload = field(event, :payload)

    unless name in @event_names and base_revision == state.revision and
             revision == state.revision + 1 do
      raise "invalid reference event sequence"
    end

    case Reducer.apply_event(state, %{
           "name" => name,
           "base_revision" => base_revision,
           "revision" => revision,
           "payload" => payload
         }) do
      {:ok, next} -> next
      {:error, reason} -> raise "independent reducer rejected event: #{inspect(reason)}"
    end
  end

  defp field(event, key), do: Map.get(event, key, Map.get(event, Atom.to_string(key)))
end
