defmodule ChalkSync.WhiteboardV1.DrawPolicyRuleTest do
  use ChalkSync.WhiteboardV1.DrawPolicyCase, async: false

  alias ChalkSync.WhiteboardV1.PostgresRepository

  test "an existing call without a policy keeps the role default and per-person choices", %{
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    assert welcome_drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: true,
             observer: false
           }

    set_permission(host, collaborator, false, "permission-revoke-0001")
    assert {:error, :permission_denied} = draw(collaborator, "update-revoked-00001")

    assert welcome_drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: false,
             observer: false
           }
  end

  test "one rule combines the policy, the role and the per-person choice", %{
    host: host,
    collaborator: collaborator,
    observer: observer
  } do
    set_policy(host, "hosts", "policy-hosts-000001")

    assert drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: false,
             observer: false
           }

    assert {:error, :permission_denied} = draw(collaborator, "update-hosts-000001")
    assert {:ok, %{outcome: :committed}} = draw(host, "update-hosts-000002")

    # Under hosts only, a host's earlier choice for a person is kept but ignored.
    set_permission(host, observer, true, "permission-grant-0001")

    assert drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: false,
             observer: false
           }

    # Picked people draw only when picked, whatever their role.
    set_policy(host, "picked", "policy-picked-00001")

    assert drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: false,
             observer: true
           }

    assert {:ok, %{outcome: :committed}} = draw(observer, "update-picked-00001")
    assert {:error, :permission_denied} = draw(collaborator, "update-picked-00002")

    set_permission(host, collaborator, true, "permission-grant-0002")
    set_permission(host, observer, false, "permission-revoke-0002")

    assert drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: true,
             observer: false
           }

    # Everyone goes back to the role default, with the same per-person choices on top.
    set_policy(host, "everyone", "policy-everyone-0001")

    assert drawers(host, collaborator, observer) == %{
             host: true,
             collaborator: true,
             observer: false
           }
  end

  test "only hosts change the policy and a retried change is a duplicate", %{
    host: host,
    collaborator: collaborator
  } do
    operation = %{operation_id: "policy-retry-000001", policy: "hosts"}

    assert {:error, :permission_denied} =
             PostgresRepository.set_draw_policy(collaborator, operation)

    assert {:ok, %{outcome: :committed}} = PostgresRepository.set_draw_policy(host, operation)
    assert {:ok, %{outcome: :duplicate}} = PostgresRepository.set_draw_policy(host, operation)
    assert {:ok, %{draw_policy: "hosts"}} = PostgresRepository.draw_access(collaborator)

    # A retry that arrives after a newer change must not undo it.
    set_policy(host, "everyone", "policy-retry-000002")
    assert {:ok, %{outcome: :duplicate}} = PostgresRepository.set_draw_policy(host, operation)
    assert {:ok, %{draw_policy: "everyone"}} = PostgresRepository.draw_access(collaborator)

    assert {:error, :operation_id_conflict} =
             PostgresRepository.set_draw_policy(host, %{operation | policy: "picked"})
  end

  test "an Episode caps policy changes, and a retry from any time in the call stays a duplicate",
       %{host: host, collaborator: collaborator} do
    for index <- 1..1024 do
      set_policy(host, policy_at(index), "policy-bound-#{pad(index)}")
    end

    assert {:error, :draw_policy_limit} =
             PostgresRepository.set_draw_policy(host, %{
               operation_id: "policy-bound-#{pad(1025)}",
               policy: "picked"
             })

    # The first change, retried after 1023 later ones, must not undo them.
    assert {:ok, %{outcome: :duplicate}} =
             PostgresRepository.set_draw_policy(host, %{
               operation_id: "policy-bound-#{pad(1)}",
               policy: policy_at(1)
             })

    assert {:ok, %{draw_policy: "hosts"}} = PostgresRepository.draw_access(collaborator)
  end

  test "unpicking someone under picked people does not block them once everyone can draw", %{
    host: host,
    collaborator: collaborator
  } do
    set_policy(host, "picked", "policy-picked-00004")
    set_permission(host, collaborator, true, "permission-pick-00001")
    set_permission(host, collaborator, false, "permission-unpick-0001")
    assert {:ok, %{grants: []}} = PostgresRepository.draw_access(host)
    refute can_draw?(collaborator)

    set_policy(host, "everyone", "policy-everyone-0002")
    assert can_draw?(collaborator)
  end

  defp pad(index), do: String.pad_leading(Integer.to_string(index), 6, "0")

  defp policy_at(index), do: Enum.at(["hosts", "everyone"], rem(index, 2))

  defp drawers(host, collaborator, observer) do
    %{
      host: can_draw?(host),
      collaborator: can_draw?(collaborator),
      observer: can_draw?(observer)
    }
  end

  defp welcome_drawers(host, collaborator, observer) do
    Map.new([host: host, collaborator: collaborator, observer: observer], fn {name, identity} ->
      {:ok, %{can_draw: can_draw}} = PostgresRepository.connect(identity)
      {name, can_draw}
    end)
  end
end
