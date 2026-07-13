defmodule ChalkSync.Auth.DevTokenVerifierTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Auth.DevTokenVerifier

  test "keeps v1 capabilities and accepts v3 role envelopes without capabilities" do
    assert {:ok, v1} =
             %{
               "tenant_id" => uuid(1),
               "room_id" => uuid(2),
               "participant_id" => uuid(3),
               "capabilities" => ["control:hand"]
             }
             |> DevTokenVerifier.token()
             |> DevTokenVerifier.verify()

    assert v1.capabilities == ["control:hand"]
    assert v1.initial_role == nil

    assert {:ok, v3} =
             %{
               "tenant_id" => uuid(1),
               "room_id" => uuid(2),
               "participant_id" => uuid(3),
               "initial_role" => "participant",
               "eligible_roles" => ["participant", "cohost"]
             }
             |> DevTokenVerifier.token()
             |> DevTokenVerifier.verify()

    assert v3.initial_role == "participant"
    assert v3.eligible_roles == ["participant", "cohost"]
    assert v3.capabilities == []
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
