defmodule ChalkSync.Auth.DevTokenVerifierTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Auth.DevTokenVerifier

  test "accepts role envelopes without token capabilities" do
    assert {:ok, claims} =
             %{
               "tenant_id" => uuid(1),
               "room_id" => uuid(2),
               "participant_id" => uuid(3),
               "initial_role" => "participant",
               "eligible_roles" => ["participant", "cohost"]
             }
             |> DevTokenVerifier.token()
             |> DevTokenVerifier.verify()

    assert claims.initial_role == "participant"
    assert claims.eligible_roles == ["participant", "cohost"]
  end

  test "rejects malformed and mixed role envelopes" do
    invalid = [
      %{"initial_role" => "participant"},
      %{"initial_role" => "participant", "eligible_roles" => ["cohost"]},
      %{
        "initial_role" => "participant",
        "eligible_roles" => ["participant", "participant"]
      },
      %{"initial_role" => "host", "eligible_roles" => ["host"]},
      %{
        "initial_role" => "participant",
        "eligible_roles" => ["participant"],
        "capabilities" => ["control:hand"]
      }
    ]

    Enum.each(invalid, fn envelope ->
      claims =
        Map.merge(
          %{
            "tenant_id" => uuid(1),
            "room_id" => uuid(2),
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
