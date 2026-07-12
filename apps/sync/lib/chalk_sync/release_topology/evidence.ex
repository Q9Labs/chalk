defmodule ChalkSync.ReleaseTopology.Evidence do
  @moduledoc false

  def create(output, schedule_name, started_at) do
    run_id = "#{format_timestamp(started_at)}-#{System.unique_integer([:positive, :monotonic])}"
    directory = Path.join([Path.expand(output), schedule_name, run_id])

    with :ok <- File.mkdir_p(directory) do
      {:ok, %{directory: directory, run_id: run_id}}
    end
  end

  def write(artifact, manifest, transitions, verdict) do
    with :ok <- write_json_lines(artifact.directory, "transitions.jsonl", transitions),
         :ok <- write_json(artifact.directory, "verdict.json", verdict),
         :ok <- write_json(artifact.directory, "reproducer.json", reproducer(manifest)),
         :ok <- write_json(artifact.directory, "manifest.json", manifest) do
      seal(Path.join(artifact.directory, "manifest.json"))
    end
  end

  def sha256(value) when is_binary(value),
    do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)

  defp write_json_lines(directory, name, values) do
    contents =
      values
      |> Enum.map(&(JSON.encode!(&1) <> "\n"))
      |> IO.iodata_to_binary()

    File.write(Path.join(directory, name), contents)
  end

  defp write_json(directory, name, value) do
    File.write(Path.join(directory, name), JSON.encode!(value) <> "\n")
  end

  defp reproducer(manifest) do
    %{
      "environment" => manifest["environment"],
      "execution_mode" => manifest["execution_mode"],
      "schedule_name" => manifest["schedule"]["name"],
      "schedule_sha256" => manifest["schedule_sha256"],
      "command" =>
        "apps/sync/scripts/release-topology-failure-schedule --schedule <public-safe-schedule.json>"
    }
  end

  defp seal(path) do
    case File.chmod(path, 0o444) do
      :ok -> :ok
      {:error, reason} -> {:error, "could not seal manifest: #{:file.format_error(reason)}"}
    end
  end

  defp format_timestamp(%DateTime{} = timestamp),
    do: Calendar.strftime(timestamp, "%Y%m%dT%H%M%SZ")
end
