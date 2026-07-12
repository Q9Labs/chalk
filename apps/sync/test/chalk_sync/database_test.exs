defmodule ChalkSync.DatabaseTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Database

  test "parses a local database URL into explicit Postgrex options" do
    assert {:ok, options} =
             Database.connection_options(
               "postgres://postgres:p%40ss@127.0.0.1:56432/chalk_sync_overhaul?sslmode=disable"
             )

    assert options[:hostname] == "127.0.0.1"
    assert options[:port] == 56_432
    assert options[:username] == "postgres"
    assert options[:password] == "p@ss"
    assert options[:database] == "chalk_sync_overhaul"
    refute options[:ssl]
  end

  test "requires explicit credentials, database, and SSL mode" do
    assert Database.connection_options("postgres://localhost/chalk") ==
             {:error, :invalid_database_url}

    assert Database.connection_options("redis://user:pass@localhost/chalk?sslmode=require") ==
             {:error, :invalid_database_url}
  end
end
