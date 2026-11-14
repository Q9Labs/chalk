defmodule ChalkSync.ProviderBridge.Client.Payload do
  @moduledoc """
  Validates and normalizes the operation payload sent to the provider bridge.
  """

  alias ChalkSync.RecordingPlane
  alias ChalkSync.UUID

  @effects ~w(media.grant_publication media.revoke_publication media.remove_participant media.end_episode recording.start recording.stop)
  @max_operation_id_bytes 128
  @recording_policy_snapshot_version "episode_config.v2"
  @sources ~w(microphone camera screen)

  def normalize_operation_payload(payload) do
    payload =
      Enum.reduce(payload, %{}, fn {key, value}, acc ->
        key = if is_atom(key), do: Atom.to_string(key), else: key
        Map.put(acc, key, value)
      end)

    with {:ok, effect} <- normalize_effect(payload["effect"] || payload[:effect]),
         {:ok, tenant_id} <- required_payload_uuid(payload, "tenant_id"),
         {:ok, episode_id} <- required_payload_uuid(payload, "episode_id"),
         {:ok, result} <- optional_payload_fields(payload),
         {:ok, recording_reservation} <- recording_reservation(payload, effect) do
      result =
        result
        |> Map.merge(%{"effect" => effect, "tenant_id" => tenant_id, "episode_id" => episode_id})
        |> Map.take(
          ~w(effect tenant_id episode_id participant_id participant_generation publication_source control_revision recording_id recording_reservation)
        )

      if is_nil(recording_reservation),
        do: {:ok, Map.delete(result, "recording_reservation")},
        else: {:ok, Map.put(result, "recording_reservation", recording_reservation)}
    end
  end

  defp recording_reservation(payload, "recording.start") do
    case Map.fetch(payload, "recording_reservation") do
      {:ok, reservation} -> normalize_recording_reservation(reservation)
      :error -> {:error, {:terminal_failure, :invalid_contract}}
    end
  end

  defp recording_reservation(payload, "recording.stop") do
    if Map.has_key?(payload, "recording_reservation"),
      do: {:error, {:terminal_failure, :invalid_contract}},
      else: {:ok, nil}
  end

  defp recording_reservation(payload, _effect) do
    if Map.has_key?(payload, "recording_reservation"),
      do: {:error, {:terminal_failure, :invalid_contract}},
      else: {:ok, nil}
  end

  defp normalize_recording_reservation(reservation) when is_map(reservation) do
    reservation =
      Enum.reduce(reservation, %{}, fn {key, value}, acc ->
        key = if is_atom(key), do: Atom.to_string(key), else: key
        Map.put(acc, key, value)
      end)

    required =
      ~w(space_id participant_count max_duration_seconds input_bitrate_bps policy_snapshot_version)

    if Map.keys(reservation) |> Enum.sort() != Enum.sort(required),
      do: {:error, {:terminal_failure, :invalid_contract}},
      else: validate_recording_reservation(reservation)
  end

  defp normalize_recording_reservation(_reservation),
    do: {:error, {:terminal_failure, :invalid_contract}}

  defp validate_recording_reservation(reservation) do
    with :ok <- validate_uuid(Map.fetch!(reservation, "space_id")),
         true <-
           is_integer(Map.fetch!(reservation, "participant_count")) and
             Map.fetch!(reservation, "participant_count") in 1..10,
         true <-
           is_integer(Map.fetch!(reservation, "max_duration_seconds")) and
             Map.fetch!(reservation, "max_duration_seconds") in 1..RecordingPlane.maximum_duration_seconds(),
         true <-
           is_integer(Map.fetch!(reservation, "input_bitrate_bps")) and
             Map.fetch!(reservation, "input_bitrate_bps") in 1..4_000_000,
         true <-
           Map.fetch!(reservation, "policy_snapshot_version") ==
             @recording_policy_snapshot_version do
      {:ok, reservation}
    else
      _ -> {:error, {:terminal_failure, :invalid_contract}}
    end
  end

  defp optional_payload_fields(payload) do
    fields = [
      {"participant_id", :uuid},
      {"participant_generation", :positive_integer},
      {"publication_source", :source},
      {"control_revision", :positive_integer},
      {"recording_id", :uuid}
    ]

    Enum.reduce_while(fields, {:ok, %{}}, &put_optional_payload_field(&1, &2, payload))
  end

  defp put_optional_payload_field({key, kind}, {:ok, acc}, payload) do
    case Map.fetch(payload, key) do
      :error -> {:cont, {:ok, acc}}
      {:ok, value} -> validate_optional_payload_field(key, kind, value, acc)
    end
  end

  defp validate_optional_payload_field(key, kind, value, acc) do
    case validate_payload_value(kind, value) do
      :ok -> {:cont, {:ok, Map.put(acc, key, normalize_payload_value(kind, value))}}
      {:error, reason} -> {:halt, {:error, reason}}
    end
  end

  defp validate_payload_value(:uuid, value), do: validate_uuid(value)

  defp validate_payload_value(:positive_integer, value),
    do: if(is_integer(value) and value > 0, do: :ok, else: {:error, :invalid_contract})

  defp validate_payload_value(:source, value),
    do: if(source_string(value), do: :ok, else: {:error, :invalid_source})

  defp normalize_payload_value(:source, value), do: source_string(value)
  defp normalize_payload_value(_kind, value), do: value

  defp required_payload_uuid(payload, key) do
    case Map.fetch(payload, key) do
      {:ok, value} ->
        if(validate_uuid(value) == :ok, do: {:ok, value}, else: {:error, :invalid_contract})

      :error ->
        {:error, {:terminal_failure, :invalid_contract}}
    end
  end

  defp normalize_effect(effect) when is_atom(effect), do: normalize_effect(Atom.to_string(effect))
  defp normalize_effect(effect) when is_binary(effect) and effect in @effects, do: {:ok, effect}
  defp normalize_effect(_effect), do: {:error, {:terminal_failure, :invalid_contract}}

  defp source_string(source) when is_atom(source) do
    value = Atom.to_string(source)
    if value in @sources, do: value, else: nil
  end

  defp source_string(source) when is_binary(source),
    do: if(source in @sources, do: source, else: nil)

  defp source_string(_source), do: nil

  def validate_uuid(value) when is_binary(value) do
    if value != String.downcase(value) do
      {:error, :invalid_contract}
    else
      case UUID.dump(value) do
        {:ok, _binary} -> :ok
        :error -> {:error, :invalid_contract}
      end
    end
  end

  def validate_uuid(_value), do: {:error, :invalid_contract}

  def validate_operation_id(value)
      when is_binary(value) and byte_size(value) >= 16 and
             byte_size(value) <= @max_operation_id_bytes,
      do:
        if(Regex.match?(~r/\A[A-Za-z0-9_-]{16,128}\z/, value),
          do: :ok,
          else: {:error, {:terminal_failure, :invalid_contract}}
        )

  def validate_operation_id(_value), do: {:error, {:terminal_failure, :invalid_contract}}
end
