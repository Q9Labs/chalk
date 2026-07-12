defmodule ChalkSync.UUID do
  @moduledoc false

  @canonical ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

  @spec generate() :: String.t()
  def generate do
    <<a::48, _version::4, b::12, _variant::2, c::62>> = :crypto.strong_rand_bytes(16)
    encode(<<a::48, 4::4, b::12, 2::2, c::62>>)
  end

  @spec dump(String.t()) :: {:ok, binary()} | :error
  def dump(value) when is_binary(value) do
    normalized = String.downcase(value)

    if Regex.match?(@canonical, normalized) do
      normalized
      |> String.replace("-", "")
      |> Base.decode16(case: :lower)
    else
      :error
    end
  end

  def dump(_value), do: :error

  @spec dump!(String.t()) :: binary()
  def dump!(value) do
    case dump(value) do
      {:ok, binary} -> binary
      :error -> raise ArgumentError, "invalid UUID: #{inspect(value)}"
    end
  end

  @spec load(binary()) :: {:ok, String.t()} | :error
  def load(<<_::128>> = value), do: {:ok, encode(value)}
  def load(_value), do: :error

  @spec load!(binary()) :: String.t()
  def load!(value) do
    case load(value) do
      {:ok, uuid} -> uuid
      :error -> raise ArgumentError, "invalid UUID bytes"
    end
  end

  defp encode(<<a::32, b::16, c::16, d::16, e::48>>) do
    Enum.join(
      [hex(a, 8), hex(b, 4), hex(c, 4), hex(d, 4), hex(e, 12)],
      "-"
    )
  end

  defp hex(value, width) do
    value |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(width, "0")
  end
end
