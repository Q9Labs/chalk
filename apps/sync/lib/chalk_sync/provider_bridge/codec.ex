defmodule ChalkSync.ProviderBridge.Codec do
  @moduledoc false

  @max_identifier_bytes 256
  @max_reason_bytes 64
  @sources ~w(microphone camera screen)
  @reason_atoms %{
    "conflict" => :conflict,
    "executor_unavailable" => :executor_unavailable,
    "fingerprint_conflict" => :fingerprint_conflict,
    "forbidden" => :forbidden,
    "invalid_contract" => :invalid_contract,
    "invalid_publication_reference" => :invalid_publication_reference,
    "invalid_token" => :invalid_token,
    "legacy_publication_reference" => :legacy_publication_reference,
    "malformed_response" => :malformed_response,
    "not_found" => :not_found,
    "observation_unavailable" => :observation_unavailable,
    "observation_update_failed" => :observation_update_failed,
    "participant_generation_required" => :participant_generation_required,
    "provider_denied" => :provider_denied,
    "provider_rate_limited" => :provider_rate_limited,
    "provider_rejected" => :provider_rejected,
    "provider_result_ambiguous" => :provider_result_ambiguous,
    "provider_unauthorized" => :provider_unauthorized,
    "provider_unavailable" => :provider_unavailable,
    "rate_limited" => :rate_limited,
    "recording_capacity_unavailable" => :recording_capacity_unavailable,
    "recording_controller_unavailable" => :recording_controller_unavailable,
    "recording_id_required" => :recording_id_required,
    "recording_invalid_envelope" => :recording_invalid_envelope,
    "recording_terminal_state" => :recording_terminal_state,
    "recording_unavailable" => :recording_unavailable,
    "response_too_large" => :response_too_large,
    "timeout" => :timeout,
    "unauthenticated" => :unauthenticated,
    "unsupported_effect" => :unsupported_effect
  }

  @spec normalize_response(non_neg_integer(), term(), pos_integer()) ::
          {:ok, map()} | {:error, term()}
  def normalize_response(status, body, max_bytes) when is_integer(status) do
    case bounded_binary(body, max_bytes) do
      {:ok, bounded} -> normalize_decoded_response(status, decode_json(bounded))
      {:error, :response_too_large} -> {:error, {:retryable_failure, :response_too_large}}
      {:error, _reason} -> {:error, {:retryable_failure, :malformed_response}}
    end
  end

  defp normalize_decoded_response(status, {:ok, payload}) when status in 200..299,
    do: {:ok, payload}

  defp normalize_decoded_response(status, {:ok, payload}),
    do: {:error, http_failure(status, payload)}

  defp normalize_decoded_response(status, {:error, _reason}) when status in 200..299,
    do: {:error, {:retryable_failure, :malformed_response}}

  defp normalize_decoded_response(status, {:error, _reason}),
    do: {:error, http_failure(status, %{})}

  @spec decode_operation_response(map(), String.t(), map()) ::
          {:ok, ChalkSync.MediaPlane.outcome()} | {:error, term()}
  def decode_operation_response(payload, operation_id, request_payload) when is_map(payload) do
    effect = request_payload["effect"]
    allowed = MapSet.new(["operation_id", "effect", "outcome", "reason"])

    keys = MapSet.new(Map.keys(payload))

    with true <- MapSet.subset?(keys, allowed),
         true <- MapSet.subset?(MapSet.new(["operation_id", "effect", "outcome"]), keys),
         ^operation_id <- fetch_binary(payload, "operation_id"),
         ^effect <- fetch_binary(payload, "effect"),
         :ok <- validate_reason(payload),
         {:ok, outcome} <- decode_outcome(payload) do
      {:ok, outcome}
    else
      _ -> {:error, {:retryable_failure, :malformed_response}}
    end
  end

  def decode_operation_response(_payload, _operation_id, _request_payload),
    do: {:error, {:retryable_failure, :malformed_response}}

  @spec decode_observation_response(map(), pos_integer(), pos_integer()) ::
          {:ok, ChalkSync.MediaPlane.observation()} | {:error, atom()}
  def decode_observation_response(payload, max_observations, max_publications)
      when is_map(payload) do
    with :ok <- validate_observation_envelope(payload),
         {:ok, observation} <-
           decode_observations(payload["observations"], max_observations, max_publications),
         :ok <- validate_next_cursor_matches(payload["next_cursor"], observation) do
      {:ok, observation}
    end
  end

  def decode_observation_response(_payload, _max_observations, _max_publications),
    do: {:error, :malformed_response}

  defp decode_outcome(%{"outcome" => outcome} = payload) when is_binary(outcome) do
    reason = bounded_reason(payload)

    case outcome do
      "confirmed" ->
        {:ok, :confirmed}

      "satisfied" ->
        {:ok, :satisfied}

      "ambiguous" ->
        {:ok, :ambiguous}

      "retryable_failure" ->
        {:ok, {:retryable_failure, reason || :provider_unavailable}}

      "terminal_failure" ->
        {:ok, {:terminal_failure, reason || :provider_rejected}}

      _ ->
        {:error, :invalid_outcome}
    end
  end

  defp decode_outcome(_payload), do: {:error, :invalid_outcome}

  defp validate_observation_envelope(
         %{
           "observations" => observations,
           "has_more" => has_more,
           "next_cursor" => next_cursor
         } = payload
       )
       when is_list(observations) and is_boolean(has_more) do
    allowed = MapSet.new(["observations", "has_more", "next_cursor"])

    with true <- MapSet.equal?(MapSet.new(Map.keys(payload)), allowed),
         true <- has_more == not is_nil(next_cursor),
         :ok <- validate_next_cursor(next_cursor) do
      :ok
    else
      _ -> {:error, :malformed_response}
    end
  end

  defp validate_observation_envelope(_payload), do: {:error, :malformed_response}
  defp validate_next_cursor(nil), do: :ok

  defp validate_next_cursor(%{"incarnation" => incarnation, "sequence" => sequence} = cursor)
       when map_size(cursor) == 2 do
    with {:ok, _incarnation} <- non_negative_integer(incarnation),
         {:ok, _sequence} <- non_negative_integer(sequence) do
      :ok
    else
      _ -> {:error, :malformed_response}
    end
  end

  defp validate_next_cursor(_cursor), do: {:error, :malformed_response}

  defp validate_next_cursor_matches(nil, _observation), do: :ok

  defp validate_next_cursor_matches(
         %{"incarnation" => incarnation, "sequence" => sequence},
         %{incarnation: incarnation, sequence: sequence}
       ),
       do: :ok

  defp validate_next_cursor_matches(_cursor, _observation), do: {:error, :malformed_response}

  defp decode_observations(observations, max_observations, max_publications) do
    with true <- length(observations) <= max_observations,
         {:ok, decoded} <- decode_observation_list(observations, max_publications),
         :ok <- ordered_observations?(decoded) do
      case List.last(decoded) do
        nil -> {:ok, %{incarnation: 0, sequence: 0, publications: []}}
        observation -> {:ok, observation}
      end
    else
      false -> {:error, :observation_limit}
      {:error, reason} -> {:error, reason}
      :error -> {:error, :malformed_response}
    end
  end

  defp decode_observation_list(observations, max_publications) do
    Enum.reduce_while(observations, {:ok, []}, fn observation, {:ok, acc} ->
      case decode_observation(observation, max_publications) do
        {:ok, decoded} -> {:cont, {:ok, [decoded | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, decoded} -> {:ok, Enum.reverse(decoded)}
      error -> error
    end
  end

  defp decode_observation(%{} = observation, max_publications) do
    with :ok <- validate_observation_fields(observation),
         {:ok, incarnation} <- non_negative_integer(observation["incarnation"]),
         {:ok, sequence} <- non_negative_integer(observation["sequence"]),
         true <- is_list(observation["publications"]),
         true <- length(observation["publications"]) <= max_publications,
         {:ok, publications} <- decode_publications(observation["publications"]) do
      {:ok, %{incarnation: incarnation, sequence: sequence, publications: publications}}
    else
      false -> {:error, :publication_limit}
      {:error, reason} -> {:error, reason}
      _ -> {:error, :malformed_response}
    end
  end

  defp decode_observation(_observation, _max_publications), do: {:error, :malformed_response}

  defp validate_observation_fields(observation) do
    allowed = MapSet.new(["incarnation", "sequence", "publications"])

    if MapSet.equal?(MapSet.new(Map.keys(observation)), allowed),
      do: :ok,
      else: {:error, :malformed_response}
  end

  defp decode_publications(publications) do
    Enum.reduce_while(publications, {:ok, []}, fn publication, {:ok, acc} ->
      case decode_publication(publication) do
        {:ok, decoded} -> {:cont, {:ok, [decoded | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, decoded} -> {:ok, Enum.reverse(decoded)}
      error -> error
    end
  end

  defp decode_publication(
         %{
           "participant_id" => participant,
           "source" => source,
           "enabled" => enabled,
           "publication_id" => publication_id
         } = publication
       ) do
    with :ok <- validate_publication_fields(publication),
         true <- valid_identifier?(participant),
         true <- is_boolean(enabled),
         true <- valid_publication_id?(publication_id),
         true <- enabled == not is_nil(publication_id),
         {:ok, decoded_source} <- decode_source(source) do
      {:ok,
       %{
         participant_id: participant,
         source: decoded_source,
         enabled: enabled,
         publication_id: publication_id
       }}
    else
      {:error, reason} -> {:error, reason}
      _ -> {:error, :malformed_response}
    end
  end

  defp decode_publication(_publication), do: {:error, :malformed_response}

  defp validate_publication_fields(publication) do
    allowed = MapSet.new(["participant_id", "source", "enabled", "publication_id"])

    if MapSet.equal?(MapSet.new(Map.keys(publication)), allowed),
      do: :ok,
      else: {:error, :malformed_response}
  end

  defp valid_identifier?(value),
    do: is_binary(value) and byte_size(value) > 0 and byte_size(value) <= @max_identifier_bytes

  defp valid_publication_id?(nil), do: true
  defp valid_publication_id?(value), do: valid_identifier?(value)

  defp decode_source(source) when source in @sources,
    do: {:ok, String.to_existing_atom(source)}

  defp decode_source(source) when is_binary(source), do: {:error, :invalid_source}
  defp decode_source(_source), do: {:error, :malformed_response}

  defp ordered_observations?([]), do: :ok

  defp ordered_observations?([first | rest]) do
    Enum.reduce_while(rest, first, fn next, previous ->
      if cursor(previous) < cursor(next), do: {:cont, next}, else: {:halt, :error}
    end)
    |> case do
      :error -> :error
      _last -> :ok
    end
  end

  defp cursor(%{incarnation: incarnation, sequence: sequence}), do: {incarnation, sequence}

  defp fetch_binary(payload, key) do
    case Map.get(payload, key) do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp validate_reason(payload) do
    case Map.fetch(payload, "reason") do
      :error -> :ok
      {:ok, value} when is_binary(value) and byte_size(value) in 1..@max_reason_bytes -> :ok
      _ -> {:error, :invalid_reason}
    end
  end

  defp bounded_reason(payload) when is_map(payload) do
    reason = Map.get(payload, "reason")

    case reason do
      value when is_binary(value) and byte_size(value) <= @max_reason_bytes -> reason_atom(value)
      _ -> nil
    end
  end

  defp bounded_reason(_payload), do: nil
  defp reason_atom(reason), do: Map.get(@reason_atoms, reason)

  defp http_failure(429, _payload), do: {:retryable_failure, :rate_limited}

  defp http_failure(status, _payload) when status >= 500,
    do: {:retryable_failure, :provider_unavailable}

  defp http_failure(400, payload), do: terminal_failure(payload, :invalid_contract)
  defp http_failure(401, payload), do: terminal_failure(payload, :invalid_token)
  defp http_failure(403, payload), do: terminal_failure(payload, :forbidden)
  defp http_failure(404, payload), do: terminal_failure(payload, :not_found)

  defp http_failure(409, payload) do
    case bounded_reason(payload) do
      :fingerprint_conflict -> {:terminal_failure, :fingerprint_conflict}
      reason -> {:terminal_failure, reason || :conflict}
    end
  end

  defp http_failure(status, payload) when status >= 400,
    do: terminal_failure(payload, :invalid_contract)

  defp http_failure(_status, _payload), do: {:retryable_failure, :transport_error}

  defp terminal_failure(payload, fallback),
    do: {:terminal_failure, bounded_reason(payload) || fallback}

  defp decode_json(body) when is_binary(body) do
    case JSON.decode(body) do
      {:ok, payload} when is_map(payload) -> {:ok, payload}
      _ -> {:error, :malformed_response}
    end
  rescue
    _ -> {:error, :malformed_response}
  end

  defp bounded_binary(body, limit) when is_binary(body) do
    if byte_size(body) <= limit, do: {:ok, body}, else: {:error, :response_too_large}
  end

  defp bounded_binary(body, limit) do
    binary = IO.iodata_to_binary(body)
    bounded_binary(binary, limit)
  rescue
    _ -> {:error, :malformed_response}
  end

  defp non_negative_integer(value) when is_integer(value) and value >= 0, do: {:ok, value}
  defp non_negative_integer(_value), do: {:error, :malformed_response}
end
