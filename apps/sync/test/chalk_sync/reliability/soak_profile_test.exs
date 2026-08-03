defmodule ChalkSync.Reliability.SoakProfileTest do
  use ExUnit.Case, async: false

  alias ChalkSync.ExternalSyncNode
  alias ChalkSync.Reliability.Wire
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestWSClient, as: Client

  @moduletag :reliability_soak
  @moduletag timeout: 900_000
  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL")
  @client_count String.to_integer(System.get_env("CHALK_SYNC_SOAK_CLIENTS", "12"))
  @commands_per_client String.to_integer(System.get_env("CHALK_SYNC_SOAK_COMMANDS", "20"))
  @duration_ms String.to_integer(System.get_env("CHALK_SYNC_SOAK_DURATION_SECONDS", "0")) *
                 1_000
  @command_interval_ms String.to_integer(
                         System.get_env("CHALK_SYNC_SOAK_COMMAND_INTERVAL_MS", "0")
                       )
  @p95_budget_ms String.to_integer(System.get_env("CHALK_SYNC_SOAK_P95_BUDGET_MS", "2500"))

  setup_all do
    if is_nil(@database_url), do: raise("soak profile requires CHALK_SYNC_TEST_DATABASE_URL")

    if @client_count < 2 or @commands_per_client < 1 or @duration_ms < 0 or
         @command_interval_ms < 0 or @p95_budget_ms < 1 do
      raise "soak profile counts and latency budget must be positive"
    end

    :ok
  end

  test "concurrent real clients remain correct and recoverable under sustained load" do
    [connection] = SyncPostgres.start_connections(@database_url, 1)
    Process.unlink(connection)

    fixtures =
      Enum.map(1..@client_count, fn _index ->
        SyncPostgres.seed_episode(connection, 1)
      end)

    on_exit(fn ->
      Enum.each(fixtures, &SyncPostgres.cleanup(connection, &1.episode))
      stop_connection(connection)
    end)

    ports =
      Enum.map(["soak-a", "soak-b", "soak-c"], fn node_id ->
        start_node(node_id)
      end)

    started_at = System.monotonic_time(:millisecond)
    deadline_ms = started_at + @duration_ms

    results =
      fixtures
      |> Enum.with_index(1)
      |> Task.async_stream(
        fn {fixture, index} ->
          exercise_client(
            fixture,
            index,
            Enum.at(ports, rem(index - 1, length(ports))),
            deadline_ms
          )
        end,
        max_concurrency: @client_count,
        ordered: false,
        timeout: 600_000
      )
      |> Enum.map(fn
        {:ok, result} -> result
        {:exit, reason} -> flunk("soak client failed: #{inspect(reason)}")
      end)
      |> Enum.sort_by(& &1.client_index)

    elapsed_ms = max(System.monotonic_time(:millisecond) - started_at, 1)
    latencies = Enum.flat_map(results, & &1.latencies_ms)
    p95_ms = percentile(latencies, 0.95)
    p99_ms = percentile(latencies, 0.99)
    max_ms = Enum.max(latencies)
    command_count = length(latencies)
    observed_counts = Enum.map(results, &length(&1.latencies_ms))
    recovery_count = Enum.sum(Enum.map(results, & &1.recovery_count))

    assert command_count >= @client_count * @commands_per_client
    assert elapsed_ms >= @duration_ms
    assert p95_ms <= @p95_budget_ms

    Enum.zip(fixtures, results)
    |> Enum.each(fn {fixture, result} ->
      recovery_port = Enum.at(ports, rem(result.client_index, length(ports)))
      {recovered, welcome} = Wire.connect_v1(recovery_port, hd(fixture.identities))
      assert welcome["head"]["revision"] == result.final_revision
      Client.close(recovered)
    end)

    write_result(%{
      "client_count" => @client_count,
      "minimum_commands_per_client" => @commands_per_client,
      "requested_duration_ms" => @duration_ms,
      "command_interval_ms" => @command_interval_ms,
      "observed_commands_per_client" => %{
        "minimum" => Enum.min(observed_counts),
        "maximum" => Enum.max(observed_counts)
      },
      "command_count" => command_count,
      "delivery_recovery_count" => recovery_count,
      "elapsed_ms" => elapsed_ms,
      "throughput_commands_per_second" => Float.round(command_count * 1_000 / elapsed_ms, 2),
      "latency_ms" => %{"p95" => p95_ms, "p99" => p99_ms, "max" => max_ms},
      "invariants" => %{
        "all_commands_committed" => true,
        "all_clients_recovered_exact_revision" => true,
        "delivery_recoveries_completed" => true,
        "multi_node_execution" => true,
        "minimum_duration_met" => true,
        "p95_within_budget" => true
      },
      "verdict" => "pass"
    })
  end

  defp exercise_client(fixture, client_index, port, deadline_ms) do
    identity = hd(fixture.identities)
    {client, welcome} = Wire.connect_v1(port, identity)
    initial_revision = welcome["head"]["revision"]

    result =
      exercise_commands(
        %{
          client: client,
          identity: identity,
          port: port,
          client_index: client_index,
          deadline_ms: deadline_ms,
          latencies_ms: [],
          revision: initial_revision,
          recovery_count: 0
        },
        1
      )

    Client.close(result.client)

    %{
      client_index: client_index,
      final_revision: result.revision,
      latencies_ms: result.latencies_ms,
      recovery_count: result.recovery_count
    }
  end

  defp exercise_commands(state, iteration) do
    if iteration <= @commands_per_client or
         System.monotonic_time(:millisecond) < state.deadline_ms do
      command_id =
        "soak-client-#{pad(state.client_index, 4)}-command-#{pad(iteration, 8)}"

      started_at = System.monotonic_time(:millisecond)
      expected_revision = state.revision + 1

      {client, command_recoveries} =
        commit_with_recovery(
          state.client,
          state.identity,
          state.port,
          command_id,
          rem(iteration, 2) == 1,
          expected_revision,
          20
        )

      elapsed_ms = System.monotonic_time(:millisecond) - started_at
      if @command_interval_ms > 0, do: Process.sleep(@command_interval_ms)

      next = %{
        state
        | client: client,
          latencies_ms: [elapsed_ms | state.latencies_ms],
          revision: expected_revision,
          recovery_count: state.recovery_count + command_recoveries
      }

      exercise_commands(next, iteration + 1)
    else
      state
    end
  end

  defp commit_with_recovery(
         _client,
         _identity,
         _port,
         command_id,
         _raised,
         _expected_revision,
         0
       ) do
    flunk("soak client exhausted delivery recovery attempts for #{command_id}")
  end

  defp commit_with_recovery(
         client,
         identity,
         port,
         command_id,
         raised,
         expected_revision,
         attempts
       ) do
    case Wire.commit_hand_result(client, command_id, raised) do
      {:ok, client, frames} ->
        assert frames["ack"]["outcome"] == "committed"
        assert frames["ack"]["revision"] == expected_revision
        assert frames["event"]["revision"] == expected_revision
        {client, 0}

      {:closed, 1012, reason, _client}
      when reason in ["delivery recovery required", "dependency unavailable"] ->
        recover_command(
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts - 1,
          1
        )

      {:closed, code, reason, _client} ->
        flunk("unexpected soak socket closure: #{code} #{reason}")

      {:error, :timeout, client} ->
        retry_timed_out_command(
          client,
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          0
        )

      {:error, reason, _client} ->
        flunk("soak command failed: #{inspect(reason)}")
    end
  end

  defp recover_command(
         _identity,
         _port,
         command_id,
         _raised,
         _expected_revision,
         0,
         _recovery_count
       ) do
    flunk("soak client exhausted delivery recovery attempts for #{command_id}")
  end

  defp recover_command(
         identity,
         port,
         command_id,
         raised,
         expected_revision,
         attempts,
         recovery_count
       ) do
    case Wire.connect_v1_result(port, identity) do
      {:ok, client, welcome} ->
        assert welcome["head"]["revision"] in [expected_revision - 1, expected_revision]
        client = Wire.send_hand(client, command_id, raised)

        confirm_recovered_command(
          client,
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          recovery_count
        )

      {:closed, 1012, reason, _client}
      when reason in ["delivery recovery required", "dependency unavailable"] ->
        retry_recovery(
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          recovery_count
        )

      {:error, _reason} ->
        retry_recovery(
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          recovery_count
        )

      {:error, _reason, _client} ->
        retry_recovery(
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          recovery_count
        )

      {:closed, code, reason, _client} ->
        flunk("unexpected soak recovery closure: #{code} #{reason}")
    end
  end

  defp confirm_recovered_command(
         client,
         identity,
         port,
         command_id,
         raised,
         expected_revision,
         attempts,
         recovery_count
       ) do
    case Wire.receive_command_ack(client, command_id) do
      {:ok, client, ack} ->
        assert ack["outcome"] == "committed"
        assert ack["revision"] == expected_revision
        {client, recovery_count}

      {:closed, 1012, reason, _client}
      when reason in ["delivery recovery required", "dependency unavailable"] ->
        retry_recovery(
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          recovery_count
        )

      {:closed, code, reason, _client} ->
        flunk("unexpected soak recovery closure: #{code} #{reason}")

      {:error, :timeout, client} ->
        retry_timed_out_command(
          client,
          identity,
          port,
          command_id,
          raised,
          expected_revision,
          attempts,
          recovery_count
        )

      {:error, reason, _client} ->
        flunk("soak recovery failed: #{inspect(reason)}")
    end
  end

  defp retry_recovery(
         identity,
         port,
         command_id,
         raised,
         expected_revision,
         attempts,
         recovery_count
       ) do
    Process.sleep(100)

    recover_command(
      identity,
      port,
      command_id,
      raised,
      expected_revision,
      attempts - 1,
      recovery_count + 1
    )
  end

  defp retry_timed_out_command(
         client,
         identity,
         port,
         command_id,
         raised,
         expected_revision,
         attempts,
         recovery_count
       ) do
    safe_close_tcp(client)

    retry_recovery(
      identity,
      port,
      command_id,
      raised,
      expected_revision,
      attempts,
      recovery_count
    )
  end

  defp safe_close_tcp(client) do
    Client.close_tcp(client)
    :ok
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
  end

  defp start_node(node_id) do
    port = Wire.available_port()

    node =
      start_supervised!(
        {ExternalSyncNode,
         app_dir: Path.expand("../../..", __DIR__),
         database_url: @database_url,
         node_id: node_id,
         port: port}
      )

    assert {:ok, %{"node_id" => ^node_id, "port" => ^port}} =
             ExternalSyncNode.await_ready(node)

    port
  end

  defp percentile(values, fraction) do
    sorted = Enum.sort(values)
    index = max(ceil(length(sorted) * fraction) - 1, 0)
    Enum.at(sorted, index)
  end

  defp pad(value, width) do
    value |> Integer.to_string() |> String.pad_leading(width, "0")
  end

  defp write_result(payload) do
    if run_directory = System.get_env("CHALK_SYNC_RELIABILITY_RUN_DIR") do
      File.write!(
        Path.join(run_directory, "soak-result.json"),
        JSON.encode!(payload) <> "\n"
      )
    end
  end

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end
end
