defmodule ChalkSync.Sessions.CommandAdmissionTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Sessions.CommandAdmission
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  defmodule BlockingObservation do
    def observe_session_publications(_adapter, _session), do: Process.sleep(:infinity)
  end

  defmodule RaisingObservation do
    def observe_session_publications(_adapter, _session), do: raise("provider exploded")
  end

  test "admits at most eight database tasks for one Session and releases every lease" do
    parent = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission_name = unique_name("Admission")

    decision_fun = fn _identity, _command ->
      send(parent, {:decision_started, self()})

      receive do
        :finish -> {:retryable, :dependency_unavailable}
      end
    end

    start_supervised!(
      {CommandAdmission,
       name: admission_name, task_supervisor: task_supervisor, decision_fun: decision_fun},
      id: admission_name
    )

    identity = identity(1)
    command = command("bounded-command-01")

    leases =
      Enum.map(1..8, fn _index ->
        assert {:ok, lease} = CommandAdmission.submit(admission_name, identity, command, self())
        lease
      end)

    task_pids =
      Enum.map(1..8, fn _index ->
        assert_receive({:decision_started, pid})
        pid
      end)

    assert {:error, :overloaded} =
             CommandAdmission.submit(admission_name, identity, command, self())

    assert %{node_commands: 8, sessions: sessions} = CommandAdmission.stats(admission_name)
    assert sessions[SessionKey.authority_key(identity.session)].tasks == 8

    Enum.each(task_pids, &send(&1, :finish))

    Enum.each(leases, fn lease ->
      assert_receive {:sync_command_result, ^lease, "bounded-command-01",
                      {:retryable, :dependency_unavailable}}
    end)

    eventually(fn -> CommandAdmission.stats(admission_name).node_commands == 0 end)
    assert CommandAdmission.stats(admission_name).sessions == %{}
  end

  test "a killed task is reclaimed by its monitor" do
    parent = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission_name = unique_name("Admission")

    decision_fun = fn _identity, _command ->
      send(parent, {:decision_started, self()})
      Process.sleep(:infinity)
    end

    start_supervised!(
      {CommandAdmission,
       name: admission_name, task_supervisor: task_supervisor, decision_fun: decision_fun},
      id: admission_name
    )

    assert {:ok, _lease} =
             CommandAdmission.submit(
               admission_name,
               identity(2),
               command("killed-command-01"),
               self()
             )

    assert_receive {:decision_started, task}
    Process.exit(task, :kill)
    eventually(fn -> CommandAdmission.stats(admission_name).node_commands == 0 end)
  end

  test "different Sessions receive independent task budgets" do
    parent = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission_name = unique_name("Admission")

    decision_fun = fn _identity, _command ->
      send(parent, {:decision_started, self()})
      receive do: (:finish -> {:retryable, :dependency_unavailable})
    end

    start_supervised!(
      {CommandAdmission,
       name: admission_name, task_supervisor: task_supervisor, decision_fun: decision_fun},
      id: admission_name
    )

    command = command("isolated-command-1")

    Enum.each([identity(3), identity(4)], fn identity ->
      Enum.each(1..8, fn _index ->
        assert {:ok, _lease} = CommandAdmission.submit(admission_name, identity, command, self())
      end)
    end)

    tasks =
      Enum.map(1..16, fn _index ->
        assert_receive({:decision_started, pid})
        pid
      end)

    assert CommandAdmission.stats(admission_name).node_commands == 16
    Enum.each(tasks, &send(&1, :finish))
    eventually(fn -> CommandAdmission.stats(admission_name).node_commands == 0 end)
  end

  test "draining rejects new commands without reserving bytes or tasks" do
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission_name = unique_name("Admission")

    start_supervised!(
      {CommandAdmission, name: admission_name, task_supervisor: task_supervisor},
      id: admission_name
    )

    assert :ok = CommandAdmission.start_draining(admission_name)

    assert {:error, :server_draining} =
             CommandAdmission.submit(
               admission_name,
               identity(5),
               command("draining-command1"),
               self()
             )

    assert %{draining?: true, node_commands: 0, node_bytes: 0, sessions: %{}} =
             CommandAdmission.stats(admission_name)
  end

  test "v3 role transitions observe publications before deciding and retry observation failure" do
    previous = Application.get_env(:chalk_sync, :media_plane)

    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{observe_session_publications: {:error, :provider_unavailable}}
      )

    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    on_exit(fn ->
      if previous,
        do: Application.put_env(:chalk_sync, :media_plane, previous),
        else: Application.delete_env(:chalk_sync, :media_plane)
    end)

    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission_name = unique_name("Admission")

    start_supervised!(
      {CommandAdmission, name: admission_name, task_supervisor: task_supervisor},
      id: admission_name
    )

    identity = %{identity(6) | protocol_version: 3}

    {:ok, command} =
      Command.new("role-observation-001", :set_participant_role, %{
        "participantSessionId" => uuid(999),
        "role" => "participant"
      })

    assert {:ok, lease} = CommandAdmission.submit(admission_name, identity, command, self())

    assert_receive {:sync_command_result, ^lease, "role-observation-001",
                    {:retryable, :dependency_unavailable}}

    assert [{:observe_session_publications, nil, [identity.session]}] ==
             MediaPlaneTestAdapter.calls(adapter)
  end

  test "blocking and raising role observations are bounded dependency failures" do
    previous_media = Application.get_env(:chalk_sync, :media_plane)
    previous_timeout = Application.get_env(:chalk_sync, :external_operation_adapter_timeout_ms)
    Application.put_env(:chalk_sync, :external_operation_adapter_timeout_ms, 20)

    on_exit(fn ->
      restore_env(:media_plane, previous_media)
      restore_env(:external_operation_adapter_timeout_ms, previous_timeout)
    end)

    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name("Tasks")})
    admission_name = unique_name("Admission")

    start_supervised!(
      {CommandAdmission, name: admission_name, task_supervisor: task_supervisor},
      id: admission_name
    )

    identity = %{identity(7) | protocol_version: 3}

    for {module, id} <- [
          {BlockingObservation, "role-blocking-observe1"},
          {RaisingObservation, "role-raising-observe01"}
        ] do
      Application.put_env(:chalk_sync, :media_plane, {module, nil})

      {:ok, command} =
        Command.new(id, :set_participant_role, %{
          "participantSessionId" => uuid(998),
          "role" => "participant"
        })

      started_at = System.monotonic_time(:millisecond)
      assert {:ok, lease} = CommandAdmission.submit(admission_name, identity, command, self())

      assert_receive {:sync_command_result, ^lease, ^id, {:retryable, :dependency_unavailable}},
                     500

      assert System.monotonic_time(:millisecond) - started_at < 500
    end
  end

  defp identity(value) do
    %Identity{
      session: %SessionKey{
        tenant_id: uuid(value),
        room_id: uuid(value + 100),
        session_id: uuid(value + 200)
      },
      participant_session_id: uuid(value + 300),
      participant_session_generation: 1,
      admission_lifecycle_intent_id: uuid(value + 400),
      capabilities: ["control:hand"]
    }
  end

  defp command(id) do
    {:ok, command} = Command.new(id, :raise_hand, %{})
    command
  end

  defp uuid(value) do
    suffix = value |> Integer.to_string(16) |> String.pad_leading(12, "0")
    "018f2f65-2a77-4a44-8e9a-#{suffix}"
  end

  defp unique_name(suffix),
    do: Module.concat(__MODULE__, "#{suffix}#{System.unique_integer([:positive])}")

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp eventually(assertion, attempts \\ 100)

  defp eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(5)
      eventually(assertion, attempts - 1)
    end
  end

  defp eventually(_assertion, 0), do: flunk("admission counters did not drain")
end
