defmodule ChalkSync.CanonicalJSON do
  @moduledoc """
  Canonical JSON encoder for sync control projections.

  The v3 durable projection contains objects with schema-owned ASCII keys,
  arrays, UTF-8 strings, integers, booleans, and null. Restricting the encoder
  to those values keeps the RFC 8785 representation explicit and rejects
  unsupported numeric values before they can enter a state digest.
  """

  @spec encode!(term()) :: binary()
  def encode!(value), do: value |> encode_value() |> IO.iodata_to_binary()

  defp encode_value(nil), do: "null"
  defp encode_value(true), do: "true"
  defp encode_value(false), do: "false"
  defp encode_value(value) when is_integer(value), do: Integer.to_string(value)
  defp encode_value(value) when is_binary(value), do: JSON.encode!(value)

  defp encode_value(values) when is_list(values) do
    ["[", values |> Enum.map(&encode_value/1) |> Enum.intersperse(","), "]"]
  end

  defp encode_value(value) when is_map(value) do
    members =
      value
      |> Enum.map(fn {key, member} -> {canonical_key(key), member} end)
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {key, member} -> [JSON.encode!(key), ":", encode_value(member)] end)

    ["{", Enum.intersperse(members, ","), "}"]
  end

  defp encode_value(value) do
    raise ArgumentError, "unsupported canonical JSON value: #{inspect(value)}"
  end

  defp canonical_key(key) when is_binary(key), do: key
  defp canonical_key(key) when is_atom(key), do: Atom.to_string(key)

  defp canonical_key(key) do
    raise ArgumentError, "unsupported canonical JSON object key: #{inspect(key)}"
  end
end
