defmodule ChalkSync.Diagnostics do
  @moduledoc """
  Non-blocking, content-free Episode Diagnostic observations from Sync.

  The public facade has one failure contract: every call returns `:ok`. Event
  names, phases, states, attributes, and correlations are selected from closed
  allowlists before the bounded ETS buffer is touched.
  """

  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Telemetry
  alias ChalkSync.UUID

  @constructors %{
    sync_connect_started: {"sync.connect", "started", "started", "ordered_transition"},
    sync_connect_connected: {"sync.connect", "connected", "observed", "terminal"},
    sync_authenticate_succeeded: {"sync.authenticate", "authenticated", "succeeded", "terminal"},
    sync_authenticate_failed: {"sync.authenticate", "failed", "failed", "terminal"},
    sync_snapshot_observed: {"sync.snapshot", "snapshot", "observed", "restored_cursor"},
    sync_reconnect_started: {"sync.reconnect", "started", "started", "ordered_transition"},
    sync_reconnect_succeeded: {"sync.reconnect", "reconnected", "succeeded", "restored_cursor"},
    sync_live_succeeded: {"sync.live", "live", "succeeded", "terminal"},
    sync_disconnect_observed: {"sync.disconnect", "disconnected", "observed", "terminal"},
    sync_retry_started: {"recovery.sync.retry", "retry", "started", "retry_link"},
    sync_retry_exhausted: {"recovery.budget.exhaust", "exhausted", "failed", "budget_terminal"},
    participant_join_succeeded:
      {"participant.join", "committed", "succeeded", "participant_result"},
    participant_reconnect_observed:
      {"participant.reconnect", "reconnected", "observed", "participant_result"},
    participant_leave_received:
      {"participant.leave", "intent", "started", "membership_transition"},
    participant_leave_succeeded:
      {"participant.leave", "committed", "succeeded", "participant_result"},
    participant_rename_received:
      {"participant.rename", "intent", "started", "membership_transition"},
    participant_rename_applied:
      {"participant.rename", "committed", "succeeded", "participant_result"},
    participant_hand_received:
      {"participant.raised_hand.set", "intent", "started", "membership_transition"},
    participant_hand_applied:
      {"participant.raised_hand.set", "committed", "succeeded", "participant_result"},
    admission_policy_received:
      {"admission.policy.change", "intent", "started", "policy_decision"},
    admission_policy_applied:
      {"admission.policy.change", "committed", "succeeded", "authoritative_commit"},
    admission_policy_snapshot:
      {"admission.policy.snapshot", "snapshot", "observed", "policy_decision"},
    admission_request_received: {"admission.request", "intent", "started", "policy_decision"},
    admission_request_applied:
      {"admission.request", "committed", "succeeded", "authoritative_commit"},
    admission_admit_received: {"admission.admit", "intent", "started", "policy_decision"},
    admission_admit_applied: {"admission.admit", "committed", "succeeded", "participant_result"},
    admission_deny_received: {"admission.deny", "intent", "started", "policy_decision"},
    admission_deny_applied: {"admission.deny", "committed", "succeeded", "participant_result"},
    moderation_role_received:
      {"moderation.role.change", "intent", "started", "capability_decision"},
    moderation_role_applied:
      {"moderation.role.change", "committed", "succeeded", "command_commit"},
    moderation_capability_denied:
      {"moderation.capability.check", "denied", "failed", "capability_decision"},
    moderation_capability_authorized:
      {"moderation.capability.check", "authorized", "succeeded", "capability_decision"},
    moderation_microphone_received:
      {"moderation.microphone.disable", "intent", "started", "capability_decision"},
    moderation_microphone_applied:
      {"moderation.microphone.disable", "committed", "succeeded", "command_commit"},
    moderation_camera_received:
      {"moderation.camera.disable", "intent", "started", "capability_decision"},
    moderation_camera_applied:
      {"moderation.camera.disable", "committed", "succeeded", "command_commit"},
    moderation_screen_received:
      {"moderation.screen.disable", "intent", "started", "capability_decision"},
    moderation_screen_applied:
      {"moderation.screen.disable", "committed", "succeeded", "command_commit"},
    moderation_remove_received: {"moderation.remove", "intent", "started", "capability_decision"},
    moderation_remove_applied: {"moderation.remove", "committed", "succeeded", "command_commit"},
    moderation_ban_received: {"moderation.ban", "intent", "started", "capability_decision"},
    moderation_ban_applied: {"moderation.ban", "committed", "succeeded", "command_commit"},
    moderation_role_target_delivered:
      {"moderation.role.change", "delivered", "observed", "target_application"},
    moderation_role_target_applied:
      {"moderation.role.change", "observed", "observed", "target_application"},
    moderation_role_target_unavailable:
      {"moderation.role.change", "not_observable", "not_observable", "target_application"},
    moderation_microphone_target_delivered:
      {"moderation.microphone.disable", "delivered", "observed", "target_delivery"},
    moderation_microphone_target_applied:
      {"moderation.microphone.disable", "observed", "observed", "target_application"},
    moderation_microphone_target_unavailable:
      {"moderation.microphone.disable", "not_observable", "not_observable", "target_application"},
    moderation_camera_target_delivered:
      {"moderation.camera.disable", "delivered", "observed", "target_delivery"},
    moderation_camera_target_applied:
      {"moderation.camera.disable", "observed", "observed", "target_application"},
    moderation_camera_target_unavailable:
      {"moderation.camera.disable", "not_observable", "not_observable", "target_application"},
    moderation_screen_target_delivered:
      {"moderation.screen.disable", "delivered", "observed", "target_delivery"},
    moderation_screen_target_applied:
      {"moderation.screen.disable", "observed", "observed", "target_application"},
    moderation_screen_target_unavailable:
      {"moderation.screen.disable", "not_observable", "not_observable", "target_application"},
    moderation_remove_target_delivered:
      {"moderation.remove", "delivered", "observed", "target_delivery"},
    moderation_remove_target_applied:
      {"moderation.remove", "observed", "observed", "target_application"},
    moderation_remove_target_unavailable:
      {"moderation.remove", "not_observable", "not_observable", "target_application"},
    moderation_ban_target_delivered:
      {"moderation.ban", "delivered", "observed", "target_delivery"},
    moderation_ban_target_applied:
      {"moderation.ban", "observed", "observed", "target_application"},
    moderation_ban_target_unavailable:
      {"moderation.ban", "not_observable", "not_observable", "target_application"},
    media_request_received: {"media_request.request", "intent", "started", "capability_decision"},
    media_request_delivered: {"media_request.request", "delivered", "observed", "target_result"},
    media_request_applied: {"media_request.accept", "observed", "observed", "target_result"},
    media_request_declined: {"media_request.decline", "observed", "observed", "target_result"},
    media_request_expired: {"media_request.expire", "expired", "timed_out", "target_result"},
    media_request_not_observable:
      {"media_request.request", "not_observable", "not_observable", "target_result"},
    chat_send_received: {"chat.send", "intent", "started", "validation"},
    chat_send_committed: {"chat.send", "committed", "succeeded", "durable_commit"},
    chat_send_rejected: {"chat.send", "failed", "failed", "authorization"},
    chat_retry_deduped: {"chat.retry", "deduped", "succeeded", "retry_link"},
    chat_sender_receipt: {"chat.send", "receipt", "observed", "sender_receipt"},
    chat_projection_observed: {"chat.send", "projected", "observed", "recipient_projection"},
    chat_application_unknown:
      {"chat.send", "not_observable", "not_observable", "recipient_projection"},
    chat_page_observed: {"chat.page", "paged", "succeeded", "page_visibility"},
    chat_read_committed: {"chat.read", "read", "succeeded", "read_commit"},
    chat_attachment_commit_started:
      {"chat.attachment.commit", "intent", "started", "storage_commit"},
    chat_attachment_commit_succeeded:
      {"chat.attachment.commit", "committed", "succeeded", "storage_commit"},
    chat_attachment_failed: {"chat.attachment.fail", "failed", "failed", "failure"},
    reaction_send_received: {"reaction.send", "intent", "started", "authorization"},
    reaction_send_accepted: {"reaction.send", "committed", "succeeded", "accepted_commit"},
    reaction_send_rejected: {"reaction.send", "failed", "failed", "authorization"},
    reaction_sender_result: {"reaction.send", "receipt", "observed", "sender_result"},
    reaction_deduped: {"reaction.dedupe", "deduped", "succeeded", "dedupe_key_outcome"},
    reaction_expired: {"reaction.expire", "expired", "succeeded", "server_expiry"},
    reaction_projection_observed:
      {"reaction.send", "projected", "observed", "recipient_projection"},
    reaction_application_unknown:
      {"reaction.send", "not_observable", "not_observable", "recipient_projection"},
    microphone_applied: {"microphone.publish", "committed", "succeeded", "sync_commit"},
    microphone_failed: {"microphone.publish", "failed", "failed", "sync_commit"},
    microphone_unpublish_applied:
      {"microphone.unpublish", "committed", "succeeded", "sync_commit"},
    microphone_unpublish_failed: {"microphone.unpublish", "failed", "failed", "sync_commit"},
    camera_applied: {"camera.publish", "committed", "succeeded", "sync_commit"},
    camera_failed: {"camera.publish", "failed", "failed", "sync_commit"},
    camera_unpublish_applied: {"camera.unpublish", "committed", "succeeded", "sync_commit"},
    camera_unpublish_failed: {"camera.unpublish", "failed", "failed", "sync_commit"},
    screen_applied: {"screen.start", "committed", "succeeded", "sync_commit"},
    screen_failed: {"screen.start", "failed", "failed", "sync_commit"},
    screen_stop_applied: {"screen.stop", "committed", "succeeded", "stop_confirmation"},
    screen_stop_failed: {"screen.stop", "failed", "failed", "stop_confirmation"},
    recording_applied: {"recording.start", "committed", "succeeded", "provider_result"},
    recording_failed: {"recording.start", "failed", "failed", "provider_result"},
    recording_stop_applied: {"recording.stop", "committed", "succeeded", "provider_result"},
    recording_stop_failed: {"recording.stop", "failed", "failed", "provider_result"},
    episode_start_received: {"episode.start", "intent", "started", "policy_snapshot"},
    episode_start_applied: {"episode.start", "committed", "succeeded", "authoritative_state"},
    episode_extend_received: {"episode.deadline.extend", "intent", "started", "policy_snapshot"},
    episode_extend_applied:
      {"episode.deadline.extend", "committed", "succeeded", "authoritative_state"},
    episode_end_received: {"episode.end.authorized", "intent", "started", "policy_snapshot"},
    episode_end_applied: {"episode.end.authorized", "committed", "succeeded", "terminal_reason"},
    cleanup_started: {"cleanup.resource.release", "started", "started", "resource_release"},
    cleanup_succeeded: {"cleanup.resource.release", "succeeded", "succeeded", "child_terminal"},
    cleanup_failed: {"cleanup.resource.release", "failed", "failed", "child_terminal"},
    cleanup_fan_in_children_succeeded:
      {"cleanup.fan_in", "observed", "succeeded", "children_terminal"},
    cleanup_fan_in_children_failed: {"cleanup.fan_in", "observed", "failed", "children_terminal"},
    cleanup_fan_in_succeeded: {"cleanup.fan_in", "fan_in", "succeeded", "fan_in_terminal"},
    cleanup_fan_in_failed: {"cleanup.fan_in", "fan_in", "failed", "fan_in_terminal"},
    cleanup_complete_children_succeeded:
      {"cleanup.complete", "observed", "succeeded", "children_terminal"},
    cleanup_complete_children_failed:
      {"cleanup.complete", "observed", "failed", "children_terminal"},
    cleanup_complete_succeeded: {"cleanup.complete", "succeeded", "succeeded", "fan_in_terminal"},
    cleanup_complete_failed: {"cleanup.complete", "failed", "failed", "fan_in_terminal"},
    operation_rejected: {"operation.ended", "denied", "failed", "terminal"},
    coverage_gap: {"coverage.gap", "not_observable", "not_observable", "terminal"}
  }

  @attribute_keys ~w(action checkpoint reason result status kind direction transport media_kind
    target_state response_class delivery_status storage_state attachment_type visibility recipient_count projection_count
    observable_recipient_count attempt retryable budget_remaining duration_ms latency_ms bytes
    count cursor sequence grace_ms deadline_ms state_version policy_version release_channel)a

  @safe_values ~w(
    accepted advanced already_applied applied authorized camera capability_denied committed
    confirmed connected control cursor_reset deadline declined dependency_unavailable disconnected duplicate ended explicit
    expired failed gap hosted invalid invalid_state local localhost loaded maximum_duration
    microphone natural newer not_observable not_requested older original participant presence provider
    reconnected rejected replay retry retryable retryable_failure satisfied screen snapshot staging started
    succeeded superseded sync target_unavailable terminal terminal_failure timed_out unchanged unknown up_to_date
  )

  @safe_reason_values ~w(
    buffer_age buffer_bytes buffer_events capability_denied command_id_conflict
    dependency_unavailable diagnostics_disabled episode_ended exporter_rejected invalid_contract
    invalid_state invalid_target malformed_response not_available not_observable overloaded
    retry_exhausted scope_not_found server_unavailable stale_participant_generation timeout
    transport_error unauthorized unknown
  )

  @correlation_patterns %{
    journeyId: ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i,
    traceId: ~r/\A[0-9a-f]{32}\z/,
    spanId: ~r/\A[0-9a-f]{16}\z/,
    requestId: ~r/\A[A-Za-z0-9][A-Za-z0-9._:@+\/=\-]{0,127}\z/,
    commandId: ~r/\A[A-Za-z0-9][A-Za-z0-9._:@+\/=\-]{0,127}\z/,
    retryGroupRef: ~r/\A[A-Za-z0-9][A-Za-z0-9._:@+\/=\-]{0,127}\z/,
    providerId: ~r/\Ahmac_sha256_[0-9a-f]{64}\z/
  }

  @spec record(atom(), EpisodeKey.t() | Identity.t(), keyword()) :: :ok
  def record(constructor, scope, options \\ []) do
    if enabled?(), do: safely(fn -> build_and_buffer(constructor, scope, options) end)
    :ok
  end

  @spec gap(EpisodeKey.t(), atom(), non_neg_integer()) :: :ok
  def gap(scope, reason, count) when is_integer(count) and count > 0 do
    record(:coverage_gap, scope, attributes: %{reason: reason, count: count, kind: :gap})
  end

  def gap(_scope, _reason, _count), do: :ok

  @spec enabled?() :: boolean()
  def enabled? do
    Application.get_env(:chalk_sync, :episode_diagnostics, %{})
    |> Map.get(:mode, :off)
    |> Kernel.!==(:off)
  end

  @spec constructors() :: [atom()]
  def constructors, do: Map.keys(@constructors)

  @spec provider_hmac(binary(), binary()) :: {:ok, binary()} | {:error, :invalid_provider_id}
  def provider_hmac(provider_id, key)
      when is_binary(provider_id) and byte_size(provider_id) in 1..512 and is_binary(key) and
             byte_size(key) >= 32 do
    digest = :crypto.mac(:hmac, :sha256, key, provider_id)
    {:ok, "hmac_sha256_" <> Base.encode16(digest, case: :lower)}
  end

  def provider_hmac(_provider_id, _key), do: {:error, :invalid_provider_id}

  defp build_and_buffer(constructor, scope, options) do
    with {:ok, scope} <- normalize_scope(scope),
         {:ok, definition} <- Map.fetch(@constructors, constructor),
         {:ok, attributes} <- validate_attributes(Keyword.get(options, :attributes, %{})),
         {:ok, correlation} <- correlation(options),
         {:ok, event} <- event(definition, options, attributes, correlation),
         {:ok, encoded} <- encode_bounded(event) do
      buffer()
      |> Buffer.insert(scope, event, encoded)
      |> handle_insert_result(scope, options, byte_size(encoded))
    else
      _invalid -> telemetry(:rejected, 0, 1)
    end
  end

  defp handle_insert_result({:ok, []}, _scope, _options, bytes),
    do: telemetry(:accepted, bytes, 1)

  defp handle_insert_result({:ok, drops}, scope, options, bytes) do
    telemetry(:dropped, bytes, length(drops))

    if Keyword.get(options, :summarize_drops?, true),
      do: enqueue_drop_summaries(scope, drops)
  end

  defp handle_insert_result({:error, reason}, _scope, _options, bytes),
    do: telemetry(reason, bytes, 1)

  defp event({name, phase, state, checkpoint}, options, attributes, correlation) do
    sequence = System.unique_integer([:monotonic, :positive])

    expectation =
      %{
        "name" => name,
        "version" => 1,
        "checkpoint" => checkpoint,
        "checkpointClass" => checkpoint_class(options)
      }
      |> put_if_nonempty("deadlineAt", deadline_at(options))

    event = %{
      "version" => 1,
      "eventId" => UUID.generate(),
      "producerSequence" => sequence,
      "occurredAt" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "source" => "sync",
      "name" => name,
      "phase" => phase,
      "state" => state,
      "expectation" => expectation
    }

    event = put_if_nonempty(event, "attributes", attributes)
    event = put_if_nonempty(event, "correlation", correlation)
    event = put_if_nonempty(event, "release", release(options))

    event =
      case safe_operation_ref(Keyword.get(options, :operation_ref)) do
        nil -> event
        value -> Map.put(event, "producerOperationRef", value)
      end

    {:ok, event}
  end

  defp correlation(options) do
    observed = observed_correlation(Keyword.get(options, :observability))

    explicit = %{
      commandId: Keyword.get(options, :command_id),
      requestId: Keyword.get(options, :request_id),
      retryGroupRef: Keyword.get(options, :retry_group_ref),
      providerId: Keyword.get(options, :provider_id),
      attempt: Keyword.get(options, :attempt)
    }

    values =
      Map.merge(observed, explicit, fn _key, observed_value, explicit_value ->
        explicit_value || observed_value
      end)

    Enum.reduce_while(values, {:ok, %{}}, &correlation_entry/2)
  end

  defp correlation_entry({_key, nil}, result), do: {:cont, result}

  defp correlation_entry({:attempt, value}, {:ok, result})
       when is_integer(value) and value in 0..1_000_000,
       do: {:cont, {:ok, Map.put(result, "attempt", value)}}

  defp correlation_entry({key, value}, {:ok, result}) when is_binary(value) do
    case Map.fetch(@correlation_patterns, key) do
      {:ok, pattern} -> correlation_string(key, value, pattern, result)
      :error -> {:halt, {:error, :invalid_correlation}}
    end
  end

  defp correlation_entry(_entry, _result), do: {:halt, {:error, :invalid_correlation}}

  defp correlation_string(key, value, pattern, result) do
    if Regex.match?(pattern, value),
      do: {:cont, {:ok, Map.put(result, Atom.to_string(key), value)}},
      else: {:halt, {:error, :invalid_correlation}}
  end

  defp observed_correlation(nil), do: %{}

  defp observed_correlation(observability) do
    observability
    |> Observability.frame_fields()
    |> correlation_from_frame_fields()
  rescue
    _exception -> %{}
  catch
    :exit, _reason -> %{}
  end

  defp correlation_from_frame_fields(fields) do
    trace = parse_traceparent(fields["traceparent"])

    %{
      journeyId: fields["journey_id"],
      traceId: trace && trace.trace_id,
      spanId: trace && trace.span_id
    }
  end

  defp parse_traceparent(value) when is_binary(value) do
    case String.split(value, "-") do
      ["00", trace_id, span_id, _flags]
      when byte_size(trace_id) == 32 and byte_size(span_id) == 16 ->
        %{trace_id: trace_id, span_id: span_id}

      _ ->
        nil
    end
  end

  defp parse_traceparent(_value), do: nil

  defp validate_attributes(attributes) when is_map(attributes) and map_size(attributes) <= 32 do
    Enum.reduce_while(attributes, {:ok, %{}}, fn {key, value}, {:ok, result} ->
      key = if is_binary(key), do: String.to_existing_atom(key), else: key

      with true <- key in @attribute_keys,
           {:ok, value} <- validate_attribute_value(key, value) do
        {:cont, {:ok, Map.put(result, Atom.to_string(key), value)}}
      else
        _ -> {:halt, {:error, :invalid_attributes}}
      end
    end)
  rescue
    ArgumentError -> {:error, :invalid_attributes}
  end

  defp validate_attributes(_attributes), do: {:error, :invalid_attributes}

  defp validate_attribute_value(_key, value) when is_boolean(value), do: {:ok, value}

  defp validate_attribute_value(_key, value)
       when is_integer(value) and value >= 0 and value <= 9_007_199_254_740_991,
       do: {:ok, value}

  defp validate_attribute_value(:reason, value) when is_atom(value),
    do: validate_string_value(Atom.to_string(value), @safe_reason_values)

  defp validate_attribute_value(:reason, value) when is_binary(value),
    do: validate_string_value(value, @safe_reason_values)

  defp validate_attribute_value(_key, value) when is_atom(value),
    do: validate_string_value(Atom.to_string(value), @safe_values)

  defp validate_attribute_value(_key, value) when is_binary(value),
    do: validate_string_value(value, @safe_values)

  defp validate_attribute_value(_key, _value), do: {:error, :invalid_attribute_value}

  defp validate_string_value(value, allowlist) do
    if value in allowlist, do: {:ok, value}, else: {:error, :invalid_attribute_value}
  end

  defp checkpoint_class(options) do
    case Keyword.get(options, :checkpoint_class, :required) do
      value when value in [:required, :conditional, :best_effort] -> Atom.to_string(value)
      _ -> "required"
    end
  end

  defp deadline_at(options) do
    case Keyword.get(options, :deadline_at) do
      %DateTime{} = value -> DateTime.to_iso8601(value)
      value when is_binary(value) -> valid_deadline_at(value)
      _value -> nil
    end
  end

  defp valid_deadline_at(value) do
    case DateTime.from_iso8601(value) do
      {:ok, _datetime, 0} -> value
      _invalid -> nil
    end
  end

  defp safe_operation_ref(value)
       when is_binary(value) and byte_size(value) in 1..128 do
    if Regex.match?(~r/\A[A-Za-z0-9][A-Za-z0-9._:@+\/=\-]{0,127}\z/, value), do: value
  end

  defp safe_operation_ref(_value), do: nil

  defp normalize_scope(%Identity{episode: episode, participant_id: participant_id}) do
    with {:ok, scope} <- normalize_scope(episode),
         true <- canonical_uuid?(participant_id) do
      {:ok, Map.put(scope, "participantId", participant_id)}
    else
      _invalid -> {:error, :invalid_scope}
    end
  end

  defp normalize_scope(
         %{"tenantId" => tenant_id, "spaceId" => space_id, "episodeId" => episode_id} = scope
       ) do
    participant_id = Map.get(scope, "participantId")

    if Enum.all?([tenant_id, space_id, episode_id], &canonical_uuid?/1) and
         (is_nil(participant_id) or canonical_uuid?(participant_id)),
       do: {:ok, scope},
       else: {:error, :invalid_scope}
  end

  defp normalize_scope(%EpisodeKey{} = episode) do
    if Enum.all?([episode.tenant_id, episode.space_id, episode.episode_id], &canonical_uuid?/1) do
      {:ok,
       %{
         "tenantId" => episode.tenant_id,
         "spaceId" => episode.space_id,
         "episodeId" => episode.episode_id
       }}
    else
      {:error, :invalid_scope}
    end
  end

  defp normalize_scope(_scope), do: {:error, :invalid_scope}

  defp canonical_uuid?(value) when is_binary(value) do
    value == String.downcase(value) and match?({:ok, _bytes}, UUID.dump(value))
  end

  defp canonical_uuid?(_value), do: false

  defp encode_bounded(event) do
    encoded = JSON.encode!(event)
    if byte_size(encoded) <= 2_048, do: {:ok, encoded}, else: {:error, :event_too_large}
  rescue
    _exception -> {:error, :invalid_event}
  end

  defp enqueue_drop_summaries(scope, drops) do
    drops
    |> Enum.frequencies()
    |> Enum.each(fn {reason, count} ->
      safely(fn ->
        build_and_buffer(:coverage_gap, scope,
          attributes: %{reason: reason, count: count, kind: :gap},
          summarize_drops?: false
        )
      end)
    end)
  end

  defp put_if_nonempty(map, _key, empty) when empty == %{}, do: map
  defp put_if_nonempty(map, _key, nil), do: map
  defp put_if_nonempty(map, key, value), do: Map.put(map, key, value)

  defp release(options) do
    options
    |> Keyword.get_lazy(:release, fn ->
      Application.get_env(:chalk_sync, :episode_diagnostics, %{}) |> Map.get(:release)
    end)
    |> validate_release()
  end

  defp validate_release(nil), do: nil

  defp validate_release(%{id: id} = release),
    do: validate_release(%{"id" => id, "sourceCommit" => Map.get(release, :source_commit)})

  defp validate_release(%{"id" => id} = release) do
    source_commit = Map.get(release, "sourceCommit")

    with true <- valid_release_identifier?(id),
         true <- is_nil(source_commit) or valid_release_identifier?(source_commit) do
      release_map(id, source_commit)
    else
      false -> nil
    end
  end

  defp validate_release(_release), do: nil

  defp valid_release_identifier?(value), do: not is_nil(safe_operation_ref(value))
  defp release_map(id, nil), do: %{"id" => id}
  defp release_map(id, source_commit), do: %{"id" => id, "sourceCommit" => source_commit}

  defp buffer do
    Application.get_env(:chalk_sync, :episode_diagnostics, %{})
    |> Map.get(:buffer, Buffer)
  end

  defp telemetry(outcome, bytes, count) do
    Telemetry.execute(
      [:diagnostics, :buffer],
      %{bytes: max(bytes, 0), count: max(count, 0)},
      %{outcome: outcome}
    )
  end

  defp safely(callback) do
    callback.()
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
    _kind, _reason -> :ok
  end
end
