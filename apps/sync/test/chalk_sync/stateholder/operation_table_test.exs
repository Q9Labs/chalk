defmodule ChalkSync.Stateholder.OperationTableTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Contract.GeneratedV1
  alias ChalkSync.Stateholder.OperationTable

  test "intake accepts exactly the external intents the contract publishes" do
    for intent <- GeneratedV1.metadata()["externalIntents"] do
      assert {:ok, name} = OperationTable.from_intake(intent)
      assert OperationTable.intake_name?(name)
    end
  end

  test "a stored name reads back to the operation that wrote it" do
    for name <- [:end_episode, :tenant_end_episode, :maximum_duration_expired, :mute_participant] do
      assert {:ok, ^name} = name |> OperationTable.stored_name() |> OperationTable.from_stored()
    end
  end

  test "the maximum-duration end is stored under the name the database constrains" do
    assert OperationTable.stored_name(:maximum_duration_expired) ==
             "maximum_episode_duration_expired"

    assert {:ok, :maximum_duration_expired} =
             OperationTable.from_intake("maximum_episode_duration_expired")

    assert :maximum_duration_expired in OperationTable.episode_end_names()
  end

  test "an Episode start or extension is intake-only and never read back from storage" do
    assert :error = OperationTable.from_stored("start_episode")
    assert :error = OperationTable.from_stored("extend_episode")
  end

  test "an unknown name is rejected by intake" do
    assert :error = OperationTable.from_intake("drop_database")
    refute OperationTable.intake_name?(:tenant_assign_roles)
  end
end
