defmodule ChalkSync.DatabaseSslOptionsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Database

  defp options(mode) do
    {:ok, options} =
      Database.connection_options("postgres://u:p@db.example:5432/chalk?sslmode=#{mode}")

    options
  end

  test "require encrypts without verifying the certificate" do
    assert options("require")[:ssl] == true
    assert options("require")[:ssl_opts] == [verify: :verify_none]
  end

  test "verify-full verifies the certificate against the system roots" do
    assert options("verify-full")[:ssl_opts][:verify] == :verify_peer
  end

  test "a missing or unknown mode is refused" do
    assert Database.connection_options("postgres://u:p@db.example:5432/chalk") ==
             {:error, :invalid_database_url}

    assert Database.connection_options("postgres://u:p@db.example:5432/chalk?sslmode=prefer") ==
             {:error, :invalid_database_url}
  end
end
