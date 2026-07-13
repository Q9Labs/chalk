defmodule ChalkSync.SyncBreakerV3.Artifact do
  @moduledoc false

  @schema "chalk.sync.breaker.v3"
  @max_bytes 1_048_576

  def write!(path, campaign) do
    payload = Map.put(campaign, "artifact_schema", @schema)
    envelope = %{"payload" => payload, "sha256" => checksum(payload)}
    encoded = JSON.encode!(envelope)
    ensure_bounded!(byte_size(encoded))
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, encoded)
    path
  end

  def read!(path) do
    path |> File.stat!() |> Map.fetch!(:size) |> ensure_bounded!()
    envelope = path |> File.read!() |> JSON.decode!()
    payload = Map.fetch!(envelope, "payload")

    unless envelope["sha256"] == checksum(payload) and payload["artifact_schema"] == @schema do
      raise ArgumentError, "invalid or corrupt SyncEngine v3 breaker artifact"
    end

    payload
  end

  def semantic_projection(campaign) when is_map(campaign) do
    Map.take(campaign, [
      "contract_version",
      "config",
      "phase_order",
      "phases",
      "aggregate",
      "verdict"
    ])
  end

  defp checksum(payload) do
    payload
    |> ChalkSync.CanonicalJSON.encode!()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  defp ensure_bounded!(bytes) when is_integer(bytes) and bytes <= @max_bytes, do: :ok

  defp ensure_bounded!(_bytes),
    do: raise(ArgumentError, "SyncEngine v3 breaker artifact exceeds the 1 MiB bound")
end
