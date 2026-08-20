defmodule Mix.Tasks.Sync.ReleaseArtifactTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Sync.ReleaseArtifact

  test "declares a minimum migration floor without an upper bound" do
    minimum_migration =
      Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration)

    assert minimum_migration == 20_260_819_130_000

    assert ReleaseArtifact.migration_compatibility() == %{
             "minimum" => minimum_migration,
             "maximum" => nil
           }
  end
end
