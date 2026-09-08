defmodule ChalkSync.Operations.DeploymentProofTest do
  use ExUnit.Case, async: true

  @validator Path.expand("../../infrastructure/managed-episode/scripts/validate-sync-proof")

  setup do
    directory =
      Path.join(System.tmp_dir!(), "chalk-sync-proof-#{System.unique_integer([:positive])}")

    File.mkdir!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)

    proof = %{
      schema_version: 1,
      provider: "planetscale-postgresql",
      postgresql_major: 18,
      connection_mode: "direct",
      role_query_supported: true,
      pg_stat_replication_visible: true,
      synchronous_standby_names_configured: false,
      synchronous_standbys: 0,
      require_synchronous_standby: false,
      writable_primary: true,
      fsync: "on",
      full_page_writes: "on",
      data_checksums: "on",
      synchronous_commit: "on",
      evidence_id: "test-only",
      verified_at: "2026-09-06T00:00:00Z"
    }

    %{proof: proof, path: Path.join(directory, "proof.json")}
  end

  test "single-node proof requires explicit matching deployment policy", %{
    proof: proof,
    path: path
  } do
    assert valid?(proof, path, "false")
    refute valid?(proof, path, "true")
    refute valid?(proof, path, "FALSE")
    refute valid?(Map.delete(proof, :require_synchronous_standby), path, "false")
  end

  test "single-node proof keeps primary durability requirements", %{proof: proof, path: path} do
    for setting <- [:fsync, :full_page_writes, :data_checksums, :synchronous_commit] do
      refute valid?(Map.put(proof, setting, "off"), path, "false")
    end

    refute valid?(%{proof | writable_primary: false}, path, "false")
    refute valid?(%{proof | postgresql_major: 17}, path, "false")
    refute valid?(%{proof | connection_mode: "pooled"}, path, "false")
  end

  test "existing HA proof remains valid", %{proof: proof, path: path} do
    proof = %{proof | synchronous_standby_names_configured: true, synchronous_standbys: 1}
    assert valid?(proof, path, "true")
  end

  defp valid?(proof, path, requirement) do
    File.write!(path, JSON.encode!(proof))

    {_output, status} =
      System.cmd("bash", [@validator, path, requirement], stderr_to_stdout: true)

    status == 0
  end
end
