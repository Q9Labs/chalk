defmodule Mix.Tasks.Sync.ReleaseArtifact do
  @shortdoc "Builds a uniquely identified Chalk sync OTP release"
  @moduledoc """
  Builds a production Chalk sync OTP release under `.artifacts/releases`.

      MIX_ENV=prod mix sync.release_artifact
      MIX_ENV=prod mix sync.release_artifact --output /absolute/output/root

  The task refuses a dirty worktree so the Git SHA and dependency lock identify
  the source used for every artifact byte.
  """

  use Mix.Task

  @switches [output: :string]
  @required_migration 20_260_712_180_000

  @impl Mix.Task
  def run(arguments) do
    ensure_production_environment!()
    {options, remaining, invalid} = OptionParser.parse(arguments, strict: @switches)

    if remaining != [] or invalid != [] do
      Mix.raise("invalid sync release artifact arguments: #{inspect(remaining ++ invalid)}")
    end

    Mix.Task.run("compile", ["--warnings-as-errors"])

    generated_at = DateTime.utc_now()
    git_sha = git!("rev-parse", "HEAD")
    ensure_clean_worktree!()
    short_sha = String.slice(git_sha, 0, 12)
    build_id = Calendar.strftime(generated_at, "%Y%m%dT%H%M%SZ")
    release_name = "chalk_sync-#{project_version()}-#{short_sha}-#{build_id}"
    output_root = Keyword.get(options, :output, Path.expand(".artifacts/releases"))
    release_path = Path.join(output_root, release_name)

    if File.exists?(release_path),
      do: Mix.raise("release artifact already exists: #{release_path}")

    Mix.Task.run("release", ["--path", release_path])

    File.write!(
      Path.join(release_path, "release-manifest.json"),
      manifest(generated_at, git_sha, release_name) <> "\n"
    )

    Mix.shell().info("PASS release=#{release_path}")
  end

  defp manifest(generated_at, git_sha, release_name) do
    dirty_state = git!("status", "--short")

    JSON.encode!(%{
      "artifact_id" => release_name,
      "application" => "chalk_sync",
      "application_version" => project_version(),
      "build_timestamp" => DateTime.to_iso8601(generated_at),
      "dependency_lock_sha256" => file_sha256("mix.lock"),
      "dirty_worktree" => String.trim(dirty_state) != "",
      "dirty_worktree_sha256" => sha256(dirty_state),
      "elixir_version" => System.version(),
      "erts_version" => :erlang.system_info(:version) |> List.to_string(),
      "git_sha" => git_sha,
      "migration_compatibility" => %{
        "maximum" => @required_migration,
        "minimum" => @required_migration
      },
      "otp_release" => System.otp_release(),
      "protocol_version" => 2
    })
  end

  defp ensure_production_environment! do
    if Mix.env() != :prod do
      Mix.raise("sync release artifacts require MIX_ENV=prod")
    end
  end

  defp ensure_clean_worktree! do
    if git!("status", "--short") != "" do
      Mix.raise("sync release artifacts require a clean worktree")
    end
  end

  defp project_version, do: Mix.Project.config() |> Keyword.fetch!(:version)

  defp file_sha256(path), do: path |> File.read!() |> sha256()

  defp sha256(value),
    do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)

  defp git!(command, argument) do
    case System.cmd("git", [command, argument], stderr_to_stdout: true) do
      {output, 0} -> String.trim_trailing(output)
      {output, _status} -> Mix.raise("git #{command} failed: #{String.trim(output)}")
    end
  end
end
