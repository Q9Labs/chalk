defmodule ChalkSync.SyncBreaker.TraceWriter do
  @moduledoc """
  Writes and reads portable JSONL replay artifacts.

  The caller supplies the output directory. Every artifact contains a manifest,
  fully materialized operations, ordered history records, and an optional
  checker failure, so it can be retained outside the repository and replayed by
  later tooling without recovering a random seed or process schedule.
  """

  alias ChalkSync.SyncBreaker.Checker.Failure
  alias ChalkSync.SyncBreaker.History.Record
  alias ChalkSync.SyncBreaker.Operation

  @schema_version 1

  @spec write(Path.t(), map(), keyword()) :: {:ok, Path.t()} | {:error, File.posix()}
  def write(directory, artifact, options \\ []) when is_binary(directory) and is_map(artifact) do
    with :ok <- File.mkdir_p(directory) do
      write_lines(directory, artifact, options)
    end
  end

  @spec read(Path.t()) :: {:ok, [map()]} | {:error, term()}
  def read(path) do
    with {:ok, body} <- File.read(path) do
      body |> String.split("\n", trim: true) |> decode_lines()
    end
  end

  defp decode_lines(lines) do
    Enum.reduce_while(lines, {:ok, []}, fn line, {:ok, records} ->
      case JSON.decode(line) do
        {:ok, record} -> {:cont, {:ok, records ++ [record]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp write_lines(directory, artifact, options) do
    path = Path.join(directory, Keyword.get(options, :name, default_name(artifact)))

    lines =
      artifact
      |> jsonl_records()
      |> Enum.map(&json_value/1)
      |> Enum.map_join("\n", &JSON.encode!/1)

    case File.write(path, lines <> "\n") do
      :ok -> {:ok, path}
      {:error, reason} -> {:error, reason}
    end
  end

  defp jsonl_records(artifact) do
    manifest = %{
      "kind" => "manifest",
      "schema_version" => @schema_version,
      "seed" => Map.get(artifact, :seed),
      "operation_count" => length(Map.get(artifact, :operations, [])),
      "history_count" => length(Map.get(artifact, :history, []))
    }

    operations = Enum.map(Map.get(artifact, :operations, []), &operation_record/1)
    history = Enum.map(Map.get(artifact, :history, []), &history_record/1)
    failure = failure_record(Map.get(artifact, :failure))

    [manifest | operations ++ history] ++ List.wrap(failure)
  end

  defp operation_record(%Operation{} = operation),
    do: %{"kind" => "operation", "operation" => Operation.to_map(operation)}

  defp operation_record(operation), do: %{"kind" => "operation", "operation" => operation}

  defp history_record(%Record{} = record),
    do: %{"kind" => "history", "record" => Record.to_map(record)}

  defp history_record(record), do: %{"kind" => "history", "record" => record}

  defp failure_record(nil), do: nil

  defp failure_record(%Failure{} = failure),
    do: %{"kind" => "failure", "failure" => Failure.to_map(failure)}

  defp failure_record(failure), do: %{"kind" => "failure", "failure" => failure}

  defp default_name(artifact) do
    seed = Map.get(artifact, :seed, "unknown")
    "sync-breaker-#{seed}-#{System.unique_integer([:positive])}.jsonl"
  end

  defp json_value(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), json_value(value)} end)
  end

  defp json_value(list) when is_list(list), do: Enum.map(list, &json_value/1)
  defp json_value(value) when is_boolean(value) or is_nil(value), do: value
  defp json_value(value) when is_atom(value), do: Atom.to_string(value)

  defp json_value(value) when is_tuple(value),
    do: value |> Tuple.to_list() |> Enum.map(&json_value/1)

  defp json_value(value), do: value
end
