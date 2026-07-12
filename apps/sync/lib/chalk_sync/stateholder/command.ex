defmodule ChalkSync.Stateholder.Command do
  @moduledoc "Validated command intent with its stable idempotency fingerprint."

  alias ChalkSync.CanonicalJSON

  @command_id ~r/\A[A-Za-z0-9_-]{16,64}\z/
  @max_payload_bytes 16 * 1024
  @names %{"raise_hand" => :raise_hand, "lower_hand" => :lower_hand}

  @enforce_keys [:id, :name, :payload, :fingerprint, :normalized_bytes]
  defstruct [:id, :name, :payload, :fingerprint, :normalized_bytes]

  @type t :: %__MODULE__{
          id: String.t(),
          name: :raise_hand | :lower_hand,
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
end
