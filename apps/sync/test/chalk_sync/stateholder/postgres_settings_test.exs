defmodule ChalkSync.Stateholder.PostgresSettingsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Stateholder.Postgres

  test "accepts only the declared acknowledged-write synchronous commit modes" do
    assert Postgres.durable_synchronous_commit?("on")
    assert Postgres.durable_synchronous_commit?("remote_apply")
    refute Postgres.durable_synchronous_commit?("remote_write")
    refute Postgres.durable_synchronous_commit?("off")
  end
end
