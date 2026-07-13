defmodule ChalkSync.Stateholder.Command do
  @moduledoc "Validated command intent with its stable idempotency fingerprint."

  alias ChalkSync.CanonicalJSON

  @command_id ~r/\A[A-Za-z0-9_-]{16,64}\z/
  @max_payload_bytes 16 * 1024
  @names %{
    "set_hand_raised" => :set_hand_raised,
    "set_display_name" => :set_display_name,
    "set_admission_policy" => :set_admission_policy,
    "set_participant_role" => :set_participant_role,
    "transfer_host" => :transfer_host,
    "raise_hand" => :raise_hand,
    "lower_hand" => :lower_hand
  }

  @enforce_keys [:id, :name, :payload, :fingerprint, :normalized_bytes]
  defstruct [:id, :name, :payload, :fingerprint, :normalized_bytes]

  @type t :: %__MODULE__{
          id: String.t(),
          name:
            :set_hand_raised
            | :set_display_name
            | :set_admission_policy
            | :set_participant_role
            | :transfer_host
            | :raise_hand
            | :lower_hand,
          payload: map(),
          fingerprint: binary(),
          normalized_bytes: pos_integer()
        }

  @spec new(String.t(), atom() | String.t(), map()) :: {:ok, t()} | {:error, atom()}
  def new(id, name, payload) when is_binary(id) and is_map(payload) do
    with true <- Regex.match?(@command_id, id),
         {:ok, normalized_name} <- normalize_name(name),
         :ok <- validate_payload(normalized_name, payload) do
      normalized = %{"name" => Atom.to_string(normalized_name), "payload" => payload}
      encoded = CanonicalJSON.encode!(normalized)

      if byte_size(encoded) <= @max_payload_bytes do
        {:ok,
         %__MODULE__{
           id: id,
           name: normalized_name,
           payload: payload,
           fingerprint: :crypto.hash(:sha256, encoded),
           normalized_bytes: byte_size(encoded)
         }}
      else
        {:error, :payload_too_large}
      end
    else
      false -> {:error, :invalid_command_id}
      {:error, reason} -> {:error, reason}
    end
  rescue
    ArgumentError -> {:error, :invalid_payload}
  end

  def new(_id, _name, _payload), do: {:error, :invalid_command}

  defp normalize_name(name) when is_atom(name) do
    if name in Map.values(@names), do: {:ok, name}, else: {:error, :unknown_command}
  end

  defp normalize_name(name) when is_binary(name) do
    case @names do
      %{^name => normalized} -> {:ok, normalized}
      _ -> {:error, :unknown_command}
    end
  end

  defp normalize_name(_name), do: {:error, :unknown_command}

  defp validate_payload(name, payload) when name in [:raise_hand, :lower_hand] do
    if map_size(payload) == 0, do: :ok, else: {:error, :invalid_payload}
  end

  defp validate_payload(:set_hand_raised, %{"raised" => raised} = payload)
       when map_size(payload) == 1 and is_boolean(raised),
       do: :ok

  defp validate_payload(:set_display_name, %{"displayName" => display_name} = payload)
       when map_size(payload) == 1 and is_binary(display_name) do
    if String.valid?(display_name) and display_name == String.trim(display_name) and
         byte_size(display_name) in 1..256,
       do: :ok,
       else: {:error, :invalid_payload}
  end

  defp validate_payload(:set_admission_policy, %{"policy" => policy} = payload)
       when map_size(payload) == 1 and policy in ["open", "approval", "closed"],
       do: :ok

  defp validate_payload(
         :set_participant_role,
         %{
           "participantSessionId" => participant_id,
           "role" => role
         } = payload
       )
       when map_size(payload) == 2 and is_binary(participant_id) and
              role in ["cohost", "participant"],
       do: :ok

  defp validate_payload(:transfer_host, %{"participantSessionId" => participant_id} = payload)
       when map_size(payload) == 1 and is_binary(participant_id),
       do: :ok

  defp validate_payload(_name, _payload), do: {:error, :invalid_payload}
end
