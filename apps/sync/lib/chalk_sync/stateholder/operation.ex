defmodule ChalkSync.Stateholder.Operation do
  @moduledoc "Validated external-operation intent with a stable request fingerprint."

  alias ChalkSync.CanonicalJSON
  alias ChalkSync.Stateholder.ObservedContext
  alias ChalkSync.UUID

  @request_key ~r/\A[A-Za-z0-9_-]{16,128}\z/
  @max_payload_bytes 16 * 1024
  @names %{
    "admit_participant" => :admit_participant,
    "deny_admission" => :deny_admission,
    "admission_request_expired" => :admission_request_expired,
    "mute_participant" => :mute_participant,
    "stop_participant_camera" => :stop_participant_camera,
    "stop_participant_screen_share" => :stop_participant_screen_share,
    "remove_participant" => :remove_participant,
    "start_recording" => :start_recording,
    "stop_recording" => :stop_recording,
    "recording_capture_ready" => :recording_capture_ready,
    "recording_capture_stopped" => :recording_capture_stopped,
    "participant_leave" => :participant_leave,
    "start_episode" => :start_episode,
    "extend_episode" => :extend_episode,
    "end_episode" => :end_episode,
    "tenant_set_deadline" => :tenant_set_deadline,
    "tenant_end_episode" => :tenant_end_episode,
    "maximum_episode_duration_expired" => :maximum_duration_expired,
    "maximum_duration_expired" => :maximum_duration_expired
  }

  @enforce_keys [:request_key, :name, :payload, :fingerprint, :normalized_bytes]
  defstruct [:request_key, :name, :payload, :fingerprint, :normalized_bytes, :observed_context]

  @type name ::
          :admit_participant
          | :deny_admission
          | :admission_request_expired
          | :mute_participant
          | :stop_participant_camera
          | :stop_participant_screen_share
          | :remove_participant
          | :start_recording
          | :stop_recording
          | :recording_capture_ready
          | :recording_capture_stopped
          | :participant_leave
          | :start_episode
          | :extend_episode
          | :end_episode
          | :tenant_set_deadline
          | :tenant_end_episode
          | :maximum_duration_expired

  @type t :: %__MODULE__{
          request_key: String.t(),
          name: name(),
          payload: map(),
          fingerprint: binary(),
          normalized_bytes: pos_integer(),
          observed_context: ObservedContext.t() | nil
        }

  @spec observe(t(), ObservedContext.t()) :: t()
  def observe(%__MODULE__{} = operation, %ObservedContext{} = context),
    do: %{operation | observed_context: context}

  @spec new(String.t(), atom() | String.t(), map()) :: {:ok, t()} | {:error, atom()}
  def new(request_key, name, payload) when is_binary(request_key) and is_map(payload) do
    with true <- Regex.match?(@request_key, request_key),
         {:ok, normalized_name} <- normalize_name(name),
         :ok <- validate_payload(normalized_name, payload) do
      normalized = %{"name" => Atom.to_string(normalized_name), "payload" => payload}
      encoded = CanonicalJSON.encode!(normalized)

      if byte_size(encoded) <= @max_payload_bytes do
        {:ok,
         %__MODULE__{
           request_key: request_key,
           name: normalized_name,
           payload: payload,
           fingerprint: :crypto.hash(:sha256, encoded),
           normalized_bytes: byte_size(encoded)
         }}
      else
        {:error, :payload_too_large}
      end
    else
      false -> {:error, :invalid_request_key}
      {:error, reason} -> {:error, reason}
    end
  rescue
    ArgumentError -> {:error, :invalid_payload}
  end

  def new(_request_key, _name, _payload), do: {:error, :invalid_operation}

  @spec system_recording_start(String.t(), String.t(), pos_integer()) ::
          {:ok, t()} | {:error, atom()}
  def system_recording_start(request_key, recording_id, policy_snapshot_version)
      when is_binary(recording_id) and is_integer(policy_snapshot_version) and
             policy_snapshot_version > 0 do
    new(request_key, :start_recording, %{
      "recordingId" => recording_id,
      "actorKind" => "system",
      "actorId" => "recording_policy",
      "policySnapshotVersion" => policy_snapshot_version
    })
  end

  def system_recording_start(_request_key, _recording_id, _policy_snapshot_version),
    do: {:error, :invalid_payload}

  @spec recording_capture_ready(String.t(), String.t(), String.t(), pos_integer()) ::
          {:ok, t()} | {:error, atom()}
  def recording_capture_ready(request_key, recording_id, start_operation_id, capture_epoch)
      when is_binary(recording_id) and is_binary(start_operation_id) and
             is_integer(capture_epoch) and capture_epoch > 0 do
    new(request_key, :recording_capture_ready, %{
      "recordingId" => recording_id,
      "startOperationId" => start_operation_id,
      "captureEpoch" => capture_epoch
    })
  end

  def recording_capture_ready(_request_key, _recording_id, _start_operation_id, _capture_epoch),
    do: {:error, :invalid_payload}

  @spec recording_capture_stopped(String.t(), String.t(), String.t(), pos_integer()) ::
          {:ok, t()} | {:error, atom()}
  def recording_capture_stopped(request_key, recording_id, stop_operation_id, capture_epoch)
      when is_binary(recording_id) and is_binary(stop_operation_id) and
             is_integer(capture_epoch) and capture_epoch > 0 do
    new(request_key, :recording_capture_stopped, %{
      "recordingId" => recording_id,
      "stopOperationId" => stop_operation_id,
      "captureEpoch" => capture_epoch
    })
  end

  def recording_capture_stopped(_request_key, _recording_id, _stop_operation_id, _capture_epoch),
    do: {:error, :invalid_payload}

  defp normalize_name(name) when is_atom(name) do
    if name in Map.values(@names), do: {:ok, name}, else: {:error, :unknown_operation}
  end

  defp normalize_name(name) when is_binary(name) do
    case @names do
      %{^name => normalized} -> {:ok, normalized}
      _ -> {:error, :unknown_operation}
    end
  end

  defp normalize_name(_name), do: {:error, :unknown_operation}

  defp validate_payload(name, payload)
       when name in [:participant_leave, :start_episode, :end_episode, :tenant_end_episode] do
    if map_size(payload) == 0, do: :ok, else: {:error, :invalid_payload}
  end

  defp validate_payload(:extend_episode, %{"extensionSeconds" => seconds} = payload)
       when map_size(payload) == 1 and is_integer(seconds) and seconds > 0,
       do: :ok

  defp validate_payload(
         :maximum_duration_expired,
         %{"deadlineGeneration" => generation} = payload
       )
       when map_size(payload) == 1 and is_integer(generation) and generation > 0,
       do: :ok

  defp validate_payload(name, %{"admissionRequestId" => id} = payload)
       when name in [:admit_participant, :deny_admission, :admission_request_expired] and
              map_size(payload) == 1,
       do: validate_uuid(id)

  defp validate_payload(name, %{"participantId" => id} = payload)
       when name in [
              :mute_participant,
              :stop_participant_camera,
              :stop_participant_screen_share,
              :remove_participant
            ] and map_size(payload) == 1,
       do: validate_uuid(id)

  defp validate_payload(:start_recording, %{"recordingId" => id} = payload),
    do: validate_recording_start_payload(id, payload)

  defp validate_payload(:stop_recording, %{"recordingId" => id} = payload)
       when map_size(payload) == 1,
       do: validate_uuid(id)

  defp validate_payload(
         :recording_capture_ready,
         %{
           "recordingId" => recording_id,
           "startOperationId" => start_operation_id,
           "captureEpoch" => capture_epoch
         } = payload
       )
       when map_size(payload) == 3 and is_integer(capture_epoch) and capture_epoch > 0 do
    case validate_uuid(recording_id) do
      :ok -> validate_uuid(start_operation_id)
      error -> error
    end
  end

  defp validate_payload(
         :recording_capture_stopped,
         %{
           "recordingId" => recording_id,
           "stopOperationId" => stop_operation_id,
           "captureEpoch" => capture_epoch
         } = payload
       )
       when map_size(payload) == 3 and is_integer(capture_epoch) and capture_epoch > 0 do
    case validate_uuid(recording_id) do
      :ok -> validate_uuid(stop_operation_id)
      error -> error
    end
  end

  defp validate_payload(
         :tenant_set_deadline,
         %{"deadlineAtMs" => deadline_at_ms, "deadlineGeneration" => generation} = payload
       )
       when map_size(payload) == 2 and is_integer(deadline_at_ms) and deadline_at_ms > 0 and
              is_integer(generation) and generation > 0,
       do: :ok

  defp validate_payload(_name, _payload), do: {:error, :invalid_payload}

  defp validate_recording_start_payload(recording_id, payload) do
    case validate_uuid(recording_id) do
      :ok -> validate_system_recording_start_payload(payload)
      error -> error
    end
  end

  defp validate_system_recording_start_payload(%{"recordingId" => _recording_id} = payload) do
    authority = Map.drop(payload, ["recordingId"])

    case authority do
      authority when map_size(authority) == 0 ->
        :ok

      %{
        "actorKind" => "system",
        "actorId" => "recording_policy",
        "policySnapshotVersion" => version
      }
      when is_integer(version) and version > 0 ->
        :ok

      %{"actorKind" => "system", "actorId" => "recording_policy"} ->
        :ok

      _ ->
        {:error, :invalid_payload}
    end
  end

  defp validate_system_recording_start_payload(_payload), do: {:error, :invalid_payload}

  defp validate_uuid(value) do
    case UUID.dump(value) do
      {:ok, _bytes} -> :ok
      :error -> {:error, :invalid_payload}
    end
  end
end
