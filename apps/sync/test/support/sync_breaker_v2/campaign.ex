defmodule ChalkSync.SyncBreakerV2.Campaign do
  @moduledoc false

  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.SyncBreakerV2.Config
  alias ChalkSync.SyncBreakerV2.Runner
  alias ChalkSync.SyncBreakerV2.TraceArtifact
  alias ChalkSync.SyncBreakerV2.Verifier
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  def run(options \\ []) do
    config = Config.new!(options)
    artifact = TraceArtifact.create(config)

    result =
      try do
        with_runtime(config, fn runtime ->
          with_fault(config, fn -> execute(config, runtime) end)
        end)
      rescue
        error ->
          Verifier.failed_result("campaign_error", Exception.message(error), [
            Verifier.setup_trace(config)
          ])
      catch
        kind, reason ->
          Verifier.failed_result("campaign_exit", Exception.format_banner(kind, reason), [
            Verifier.setup_trace(config)
          ])
      end

    result = Map.update!(result, :trace, &(&1 ++ [Verifier.verdict_trace(result)]))
    :ok = TraceArtifact.write(artifact, config, result)

    %{
      verdict: String.downcase(result.verdict) |> String.to_atom(),
      run_directory: artifact.directory,
      invariants: result.invariants
    }
  end

  defp execute(config, runtime) do
    {outcomes, command_trace} = Runner.run(config, runtime.adapter, runtime.fixtures)
    trace = [Verifier.setup_trace(config) | command_trace]

    case Enum.find(outcomes, &match?({:error, _}, &1)) do
      {:error, failure} -> Verifier.failed_result("idempotency", failure, trace)
      nil -> Verifier.verify(config, runtime.adapter, runtime.fixtures, trace)
    end
  end

  defp with_runtime(%{adapter: :memory} = config, fun) do
    started = ensure_memory!()
    Memory.reset()

    try do
      fixtures =
        Enum.map(1..config.sessions, fn _ -> seed_memory_session(config.participants) end)

      fun.(%{adapter: :memory, fixtures: fixtures})
    after
      if started, do: GenServer.stop(Memory)
      if Process.whereis(Memory), do: Memory.reset()
    end
  end

  defp with_runtime(%{adapter: :postgres} = config, fun) do
    database_url =
      config.database_url || System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
        System.get_env("CHALK_DATABASE_URL")

    unless is_binary(database_url) do
      raise ArgumentError,
            "postgres adapter requires --database-url or CHALK_SYNC_TEST_DATABASE_URL"
    end

    previous_connections = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(database_url)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    {:ok, fixture_store} = Agent.start_link(fn -> [] end)

    try do
      fixtures =
        Enum.map(1..config.sessions, fn _ ->
          fixture = SyncPostgres.seed_session(hd(connections), config.participants)
          Agent.update(fixture_store, &[fixture | &1])
          fixture
        end)

      fun.(%{adapter: :postgres, fixtures: fixtures})
    after
      fixture_store
      |> Agent.get(& &1)
      |> Enum.each(&SyncPostgres.cleanup(hd(connections), &1.session))

      Agent.stop(fixture_store)
      restore_env(:database_connections, previous_connections)
      Enum.each(connections, &stop_connection/1)
    end
  end

  defp seed_memory_session(participant_count) do
    session = %SessionKey{
      tenant_id: UUID.generate(),
      room_id: UUID.generate(),
      session_id: UUID.generate()
    }

    participants =
      Enum.map(1..participant_count, fn index ->
        %{
          id: UUID.generate(),
          generation: 1,
          display_name: "Breaker Participant #{index}",
          capabilities: ["control:hand"],
          admission_lifecycle_intent_id: UUID.generate()
        }
      end)

    :ok = Memory.seed_session(session, participants)

    identities =
      Enum.map(participants, fn participant ->
        %ChalkSync.Stateholder.Identity{
          session: session,
          participant_session_id: participant.id,
          participant_session_generation: participant.generation,
          admission_lifecycle_intent_id: participant.admission_lifecycle_intent_id,
          capabilities: participant.capabilities
        }
      end)

    %{session: session, identities: identities}
  end

  defp ensure_memory! do
    case Process.whereis(Memory) do
      nil ->
        {:ok, _pid} = Memory.start_link([])
        true

      _pid ->
        false
    end
  end

  defp with_fault(%{fault_point: :none}, fun), do: fun.()

  defp with_fault(%{fault_point: point}, fun) do
    {:ok, agent} = Agent.start_link(fn -> true end)
    previous_hook = Application.get_env(:chalk_sync, :stateholder_fault_hook)

    Application.put_env(
      :chalk_sync,
      :stateholder_fault_hook,
      fn checkpoint, _context -> inject_fault!(point, agent, checkpoint) end
    )

    try do
      fun.()
    after
      restore_env(:stateholder_fault_hook, previous_hook)
      Agent.stop(agent)
    end
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp inject_fault!(point, agent, checkpoint) when checkpoint == point do
    if consume_fault?(agent), do: raise("sync breaker injected #{point}")
  end

  defp inject_fault!(_point, _agent, _checkpoint), do: nil

  defp consume_fault?(agent), do: Agent.get_and_update(agent, &disarm_fault/1)
  defp disarm_fault(armed), do: {armed, false}

  defp stop_connection(connection),
    do: if(Process.alive?(connection), do: GenServer.stop(connection))
end
