defmodule ChalkSync.Obs.Ids do
  @moduledoc """
  Handles for observability ids. A handle is display and lookup syntax only: stores keep the canonical value (a
  dashed UUID, a W3C trace or span id, or a provider token). `format_handle/3` adds the prefix, `parse_handle/1`
  says what a piece of text can mean, and `resolve_handle/2` matches it against the rows in a scope and returns
  every match, so a short handle that collides is reported as ambiguous instead of guessed.

  The TypeScript and Go kernels implement the same functions; `observability/registry/vectors.json` keeps them equal.
  """

  alias ChalkSync.Obs.Registry

  @min_short 4
  @hex_length %{"uuid" => 32, "hex32" => 32, "hex16" => 16}

  @type candidate :: %{kind: String.t(), id: String.t()}
  @type handle :: %{required(:form) => String.t(), optional(atom()) => term()}
  @type target :: %{
          required(:kind) => String.t(),
          required(:id) => String.t(),
          optional(:legacy_hash) => String.t()
        }

  @doc "The stored form of an id, so two spellings of one id compare equal."
  @spec canonical_id(String.t(), String.t()) :: {:ok, String.t()} | :error
  def canonical_id(kind, id) when is_binary(id) do
    case kind_spec(kind) do
      %{"canonical" => "token"} when id != "" -> {:ok, id}
      %{"canonical" => "token"} -> :error
      nil -> :error
      spec -> with {:ok, digits} <- hex_of(spec, id), do: {:ok, stored(spec, digits)}
    end
  end

  @doc "The full handle, or with a scope the shortest prefix of at least four hex digits no other id there shares."
  @spec format_handle(String.t(), String.t(), [String.t()] | nil) :: {:ok, String.t()} | :error
  def format_handle(kind, id, scope \\ nil) when is_binary(id) do
    spec = kind_spec(kind)

    cond do
      spec == nil ->
        :error

      spec["canonical"] == "token" ->
        if id == "" or String.match?(id, ~r/\s/u),
          do: :error,
          else: {:ok, spec["prefix"] <> "_" <> id}

      true ->
        with {:ok, digits} <- hex_of(spec, id),
             do: {:ok, spec["prefix"] <> "_" <> shortest(spec, digits, scope)}
    end
  end

  defp shortest(_spec, digits, nil), do: digits

  defp shortest(spec, digits, scope) do
    others =
      for other <- scope,
          {:ok, other_digits} <- [hex_of(spec, other)],
          other_digits != digits,
          do: other_digits

    length =
      Enum.find(@min_short..String.length(digits)//1, String.length(digits), fn length ->
        prefix = String.slice(digits, 0, length)
        not Enum.any?(others, &String.starts_with?(&1, prefix))
      end)

    String.slice(digits, 0, length)
  end

  @doc "CHK- and four Crockford base32 characters from the first 20 bits of a client session id."
  @spec diagnostic_code(String.t()) :: {:ok, String.t()} | :error
  def diagnostic_code(client_session_id) do
    %{"prefix" => prefix, "length" => length, "alphabet" => alphabet} = Registry.diagnostic_code()

    with {:ok, id} <- canonical_id("client_session", client_session_id) do
      bits = id |> String.slice(0, 5) |> String.to_integer(16)

      code =
        for index <- (length - 1)..0//-1, into: "" do
          String.at(alphabet, Bitwise.band(Bitwise.bsr(bits, index * 5), 31))
        end

      {:ok, prefix <> code}
    end
  end

  @doc "Reads a full or short handle, a bare id, session:<id>, a legacy participant hash or a CHK- code."
  @spec parse_handle(String.t()) :: {:ok, handle()} | {:error, String.t()}
  def parse_handle(input) when is_binary(input) do
    text = String.trim(input)
    lower = String.downcase(text)
    %{"prefix" => code_prefix} = Registry.diagnostic_code()

    cond do
      text == "" ->
        {:error, "empty"}

      String.starts_with?(lower, String.downcase(code_prefix)) ->
        parse_code(text, code_prefix)

      String.starts_with?(lower, "session:") ->
        parse_session(binary_part(text, 8, byte_size(text) - 8))

      byte_size(lower) == 64 and hex?(lower) ->
        parse_legacy_hash(lower)

      true ->
        parse_prefixed(text, lower)
    end
  end

  defp parse_code(text, prefix) do
    %{"length" => length, "alphabet" => alphabet} = Registry.diagnostic_code()

    normalized =
      text
      |> binary_part(byte_size(prefix), byte_size(text) - byte_size(prefix))
      |> String.upcase()
      |> String.replace(["O", "I", "L"], fn
        "O" -> "0"
        _one -> "1"
      end)

    if String.length(normalized) == length and
         Enum.all?(String.graphemes(normalized), &String.contains?(alphabet, &1)) do
      {:ok, %{form: "diagnostic_code", code: prefix <> normalized}}
    else
      {:error, "bad_diagnostic_code"}
    end
  end

  defp parse_session(""), do: {:error, "empty"}

  defp parse_session(id) do
    candidates =
      for %{"kind" => kind, "lookup" => true} <- Registry.session_meanings(),
          spec = kind_spec(kind),
          spec != nil,
          candidate <- session_candidate(spec, id),
          do: candidate

    {:ok, %{form: "session", candidates: candidates}}
  end

  defp session_candidate(%{"canonical" => "token", "kind" => kind}, id),
    do: [%{kind: kind, id: id}]

  defp session_candidate(spec, id) do
    case hex_of(spec, id) do
      {:ok, digits} -> [%{kind: spec["kind"], id: stored(spec, digits)}]
      :error -> []
    end
  end

  defp parse_legacy_hash(hash) do
    case Enum.find(Registry.id_kinds(), &(&1["legacy_hash_field"] != nil)) do
      nil -> {:error, "unrecognized"}
      spec -> {:ok, %{form: "legacy_hash", kind: spec["kind"], hash: hash}}
    end
  end

  defp parse_prefixed(text, lower) do
    case :binary.match(text, "_") do
      {separator, 1} when separator > 0 ->
        prefix = binary_part(lower, 0, separator)
        rest = binary_part(text, separator + 1, byte_size(text) - separator - 1)

        case Enum.find(Registry.id_kinds(), &(&1["prefix"] == prefix)) do
          nil -> {:error, "unknown_prefix"}
          spec -> parse_value(spec, rest)
        end

      _bare ->
        parse_bare(text)
    end
  end

  defp parse_bare(text) do
    candidates =
      for spec <- Registry.id_kinds(), {:ok, digits} <- [hex_of(spec, text)] do
        %{kind: spec["kind"], id: stored(spec, digits)}
      end

    if candidates == [],
      do: {:error, "unrecognized"},
      else: {:ok, %{form: "bare", candidates: candidates}}
  end

  defp parse_value(%{"canonical" => "token"} = spec, rest) do
    if rest == "" or String.match?(rest, ~r/\s/u),
      do: {:error, "bad_value"},
      else: {:ok, %{form: "full", kind: spec["kind"], id: rest}}
  end

  defp parse_value(spec, rest) do
    digits = rest |> String.downcase() |> String.replace("-", "")
    full = @hex_length[spec["canonical"]]

    cond do
      not hex?(digits) ->
        {:error, "bad_value"}

      byte_size(digits) > full ->
        {:error, "too_long"}

      byte_size(digits) == full ->
        {:ok, %{form: "full", kind: spec["kind"], id: stored(spec, digits)}}

      byte_size(digits) < @min_short ->
        {:error, "too_short"}

      true ->
        {:ok, %{form: "short", kind: spec["kind"], prefix: digits}}
    end
  end

  @doc "Matches a parsed handle against the rows in a scope. Malformed rows are skipped and duplicates merged."
  @spec resolve_handle(handle(), [target()]) ::
          %{status: String.t(), match: candidate()}
          | %{status: String.t(), matches: [candidate()]}
          | %{status: String.t()}
  def resolve_handle(handle, targets) do
    found =
      targets
      |> Enum.flat_map(fn target ->
        case canonical_id(target.kind, target.id) do
          {:ok, id} -> [Map.put(target, :id, id)]
          :error -> []
        end
      end)
      |> Enum.filter(&matches?(handle, &1))
      |> Enum.map(&%{kind: &1.kind, id: &1.id})
      |> Enum.uniq()

    case found do
      [] -> %{status: "none"}
      [match] -> %{status: "unique", match: match}
      matches -> %{status: "ambiguous", matches: matches}
    end
  end

  defp matches?(%{form: "full", kind: kind, id: id}, target),
    do: target.kind == kind and target.id == id

  defp matches?(%{form: "short", kind: kind, prefix: prefix}, target),
    do: target.kind == kind and String.starts_with?(String.replace(target.id, "-", ""), prefix)

  defp matches?(%{form: form, candidates: candidates}, target) when form in ["bare", "session"],
    do: %{kind: target.kind, id: target.id} in candidates

  defp matches?(%{form: "legacy_hash", kind: kind, hash: hash}, target),
    do: target.kind == kind and String.downcase(Map.get(target, :legacy_hash, "")) == hash

  defp matches?(%{form: "diagnostic_code", code: code}, target),
    do: target.kind == "client_session" and diagnostic_code(target.id) == {:ok, code}

  @doc "The participant_id_hash older rows carry: the SHA-256 hex of the dashed UUID."
  @spec legacy_hash(String.t()) :: String.t()
  def legacy_hash(id), do: :sha256 |> :crypto.hash(id) |> Base.encode16(case: :lower)

  defp kind_spec(kind), do: Enum.find(Registry.id_kinds(), &(&1["kind"] == kind))

  defp hex_of(%{"canonical" => "token"}, _id), do: :error

  defp hex_of(spec, id) do
    lower = String.downcase(id)

    digits =
      if spec["canonical"] == "uuid" and dashed_uuid?(lower),
        do: String.replace(lower, "-", ""),
        else: lower

    if hex?(digits) and byte_size(digits) == @hex_length[spec["canonical"]],
      do: {:ok, digits},
      else: :error
  end

  defp stored(%{"canonical" => "uuid"}, digits) do
    <<a::binary-8, b::binary-4, c::binary-4, d::binary-4, e::binary-12>> = digits
    Enum.join([a, b, c, d, e], "-")
  end

  defp stored(_spec, digits), do: digits

  defp hex?(text), do: text != "" and String.match?(text, ~r/\A[0-9a-f]+\z/)

  defp dashed_uuid?(text),
    do: String.match?(text, ~r/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/)
end
