defmodule Mix.Tasks.Sync.ReleaseArtifactTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Sync.ReleaseArtifact

  test "declares a minimum migration floor without an upper bound" do
    minimum_migration =
      Application.fetch_env!(:chalk_sync, :minimum_compatible_sync_migration)

    assert ReleaseArtifact.migration_compatibility() == %{
             "minimum" => minimum_migration,
             "maximum" => nil
           }
  end
end
