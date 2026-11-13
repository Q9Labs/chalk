defmodule ChalkSync.Stateholder.Intake do
  @moduledoc """
  What `Command` and `Operation` share when they accept intent: the canonical form, its byte cap
  and the SHA-256 fingerprint that makes a retry recognisable.
  """

  alias ChalkSync.CanonicalJSON

  @max_payload_bytes 16 * 1024

  @doc "Raises `ArgumentError` when the payload is not canonical JSON; callers answer `:invalid_payload`."
  @spec fingerprint(atom(), map()) ::
          {:ok, binary(), pos_integer()} | {:error, :payload_too_large}
  def fingerprint(name, payload) when is_atom(name) and is_map(payload) do
    encoded = CanonicalJSON.encode!(%{"name" => Atom.to_string(name), "payload" => payload})

    if byte_size(encoded) <= @max_payload_bytes,
      do: {:ok, :crypto.hash(:sha256, encoded), byte_size(encoded)},
      else: {:error, :payload_too_large}
  end
end
