defmodule ChalkSync.Auth.DevTokenVerifierTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Auth.DevTokenVerifier

  test "accepts role and capability claims" do
    assert {:ok, claims} =
             %{
               "tenant_id" => uuid(1),
               "space_id" => uuid(2),
               "participant_id" => uuid(3),
               "role" => "observer",
               "capabilities" => ["subscribe"]
             }
             |> DevTokenVerifier.token()
             |> DevTokenVerifier.verify()

    assert claims.role == "observer"
    assert claims.capabilities == ["subscribe"]
  end

  test "rejects malformed role and capability claims" do
    invalid = [
      %{"role" => "observer"},
      %{"role" => "observer", "capabilities" => ["subscribe", "subscribe"]},
      %{"role" => "observer", "capabilities" => ["not-a-capability"]},
      %{"role" => "", "capabilities" => ["subscribe"]},
      %{"role" => "observer", "capabilities" => "subscribe"}
    ]

    Enum.each(invalid, fn envelope ->
      claims =
        Map.merge(
          %{
            "tenant_id" => uuid(1),
            "space_id" => uuid(2),
            "participant_id" => uuid(3)
          },
          envelope
        )

      assert {:error, :invalid_token} =
               claims |> DevTokenVerifier.token() |> DevTokenVerifier.verify()
    end)
  end

  defp uuid(value),
    do: "00000000-0000-4000-8000-#{value |> to_string() |> String.pad_leading(12, "0")}"
end
