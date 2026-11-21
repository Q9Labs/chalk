defmodule ChalkSync.Obs.Flags do
  @moduledoc """
  The flags map in the one canonical form every kernel hashes, so a `flags_hash` from TypeScript, Go and Elixir
  names the same flags. The vectors in observability/registry/vectors.json pin the bytes.
  """

  @doc "The flags map as canonical JSON: sorted keys, no whitespace, and only strings, booleans, integers or nil."
  @spec canonical(map()) :: {:ok, String.t()} | {:error, String.t()}
  def canonical(flags) when is_map(flags) do
    flags
    |> Enum.sort_by(fn {key, _value} -> key end)
    |> Enum.reduce_while({:ok, []}, fn {key, value}, {:ok, parts} ->
      case flag_entry(key, value) do
        {:ok, part} -> {:cont, {:ok, [part | parts]}}
        error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, parts} -> {:ok, "{" <> (parts |> Enum.reverse() |> Enum.join(",")) <> "}"}
      error -> error
    end
  end

  @max_safe_integer 9_007_199_254_740_991

  defp flag_entry(key, value) do
    cond do
      not (is_binary(key) and String.match?(key, ~r/\A[a-z][a-z0-9_.]*\z/)) ->
        {:error, "obs: flag key #{inspect(key)} must be lower snake_case with dots"}

      is_binary(value) ->
        {:ok, json_string(key) <> ":" <> json_string(value)}

      is_nil(value) or is_boolean(value) or
          (is_integer(value) and abs(value) <= @max_safe_integer) ->
        {:ok, json_string(key) <> ":" <> scalar(value)}

      true ->
        {:error, "obs: flag #{key} must be a string, boolean, integer or null"}
    end
  end

  @doc "16 hex characters of the SHA-256 of the canonical flags JSON."
  @spec hash(map()) :: {:ok, String.t()} | {:error, String.t()}
  def hash(flags) do
    with {:ok, canonical} <- canonical(flags) do
      {:ok,
       :sha256 |> :crypto.hash(canonical) |> Base.encode16(case: :lower) |> binary_part(0, 16)}
    end
  end

  defp scalar(nil), do: "null"
  defp scalar(value), do: to_string(value)

  # The escapes JavaScript's JSON.stringify writes, so every kernel hashes the same bytes.
  @escapes %{
    ?" => "\\\"",
    ?\\ => "\\\\",
    ?\b => "\\b",
    ?\f => "\\f",
    ?\n => "\\n",
    ?\r => "\\r",
    ?\t => "\\t"
  }

  defp json_string(text) do
    "\"" <> for(<<char::utf8 <- text>>, into: "", do: escape(char)) <> "\""
  end

  defp escape(char) when is_map_key(@escapes, char), do: @escapes[char]

  defp escape(char) when char < 0x20,
    do:
      "\\u" <> (char |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(4, "0"))

  defp escape(char), do: <<char::utf8>>
end
