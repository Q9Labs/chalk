defmodule ChalkSync.OperationsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Operations
  alias ChalkSync.Sessions.CommandAdmission
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  test "drain rejects new work, waits for accepted decisions, then drains coordinators" do
    parent = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission = unique_name("Admission")
    operations = unique_name("Operations")

    decision_fun = fn _identity, _command ->
      send(parent, {:decision_started, self()})

      receive do
        :finish -> {:retryable, :decision_unavailable}
      end
    end

    start_supervised!(
      {CommandAdmission,
       name: admission, task_supervisor: task_supervisor, decision_fun: decision_fun},
      id: admission
    )

    start_supervised!(
      {Operations,
       name: operations,
       admission: admission,
       drain_fun: fn ->
         send(parent, :coordinators_drained)
         :ok
       end},
      id: operations
    )

    identity = identity()
    {:ok, command} = Command.new("drain-command-001", :raise_hand, %{})
    assert {:ok, lease} = CommandAdmission.submit(admission, identity, command, self())
    assert_receive {:decision_started, task}

    drain = Task.async(fn -> Operations.begin_drain(operations, 1_000) end)
    eventually(fn -> not Operations.accepting_connections?(operations) end)

    assert {:error, :server_draining} =
             CommandAdmission.submit(admission, identity, command, self())

    send(task, :finish)

    assert_receive {:sync_command_result, ^lease, "drain-command-001",
                    {:retryable, :decision_unavailable}}

    assert Task.await(drain) == :ok
    assert_receive :coordinators_drained
    assert %{draining: true} = Operations.health(operations)
  end

  defp identity do
    %Identity{
      session: %SessionKey{
        tenant_id: "018f2f65-2a77-4a44-8e9a-000000000001",
        room_id: "018f2f65-2a77-4a44-8e9a-000000000002",
        session_id: "018f2f65-2a77-4a44-8e9a-000000000003"
      },
      participant_session_id: "018f2f65-2a77-4a44-8e9a-000000000004",
      participant_session_generation: 1,
      admission_lifecycle_intent_id: "018f2f65-2a77-4a44-8e9a-000000000005",
      capabilities: ["control:hand"]
    }
  end

  defp unique_name(suffix),
    do: Module.concat(__MODULE__, "#{suffix}#{System.unique_integer([:positive])}")

  defp eventually(assertion, attempts \\ 100)

  defp eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(5)
      eventually(assertion, attempts - 1)
    end
  end

  defp eventually(_assertion, 0), do: flunk("condition did not become true")
end
