defmodule ChalkSync.ProviderBridge.ConfigTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ProviderBridge.Config

  test "fails before startup when TLS material is missing or malformed" do
    missing = Path.join(System.tmp_dir!(), "chalk-sync-missing-client.pem")

    assert_raise ArgumentError, ~r/client certificate is unavailable/, fn ->
      Config.client!(
        base_url: "https://localhost:4101",
        certfile: missing,
        keyfile: missing,
        cacertfile: missing
      )
    end

    malformed =
      Path.join(System.tmp_dir!(), "chalk-sync-malformed-#{System.unique_integer()}.pem")

    File.write!(malformed, "not a PEM document")
    on_exit(fn -> File.rm(malformed) end)

    assert_raise ArgumentError, ~r/client certificate is not a valid PEM file/, fn ->
      Config.client!(
        base_url: "https://localhost:4101",
        certfile: malformed,
        keyfile: malformed,
        cacertfile: malformed
      )
    end
  end

  test "refuses a bridge timeout that can consume the durable consumer timeout" do
    assert_raise ArgumentError, ~r/request timeout must be shorter/, fn ->
      Config.media_plane!([], 7_000)
    end
  end

  test "builds the mTLS client with a request timeout below the consumer budget" do
    paths = tls_files()

    client =
      Config.client!(
        base_url: "https://localhost:4101",
        certfile: paths.certfile,
        keyfile: paths.keyfile,
        cacertfile: paths.cacertfile
      )

    assert client.request_timeout == 7_000
    assert client.tls[:certfile] == paths.certfile
    assert client.tls[:keyfile] == paths.keyfile
    assert client.tls[:cacertfile] == paths.cacertfile
  end

  test "installs the provider bridge media plane for live sessions at boot" do
    paths = tls_files()
    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)

    on_exit(fn -> restore_env(:media_plane, previous_media_plane) end)

    media_plane =
      Config.install_media_plane!(
        [
          base_url: "https://localhost:4101",
          certfile: paths.certfile,
          keyfile: paths.keyfile,
          cacertfile: paths.cacertfile
        ],
        8_000
      )

    assert Application.fetch_env!(:chalk_sync, :media_plane) == media_plane
  end

  defp tls_files do
    test_data = :public_key.pkix_test_data(%{root: [], peer: []})
    directory = Path.join(System.tmp_dir!(), "chalk-sync-tls-#{System.unique_integer()}")
    File.mkdir_p!(directory)

    paths = %{
      certfile: Path.join(directory, "client-cert.pem"),
      keyfile: Path.join(directory, "client-key.pem"),
      cacertfile: Path.join(directory, "ca.pem")
    }

    File.write!(
      paths.certfile,
      :public_key.pem_encode([{:Certificate, test_data[:cert], :not_encrypted}])
    )

    {key_type, key_der} = test_data[:key]

    File.write!(
      paths.keyfile,
      :public_key.pem_encode([{key_type, key_der, :not_encrypted}])
    )

    File.write!(
      paths.cacertfile,
      :public_key.pem_encode(Enum.map(test_data[:cacerts], &{:Certificate, &1, :not_encrypted}))
    )

    on_exit(fn -> File.rm_rf!(directory) end)
    paths
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
