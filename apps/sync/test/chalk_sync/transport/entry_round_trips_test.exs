defmodule ChalkSync.Transport.EntryRoundTripsTest do
  @moduledoc """
  Counts the Postgres statements a socket entry (hello until welcome) sends, one
  round trip each. Set CHALK_SYNC_ENTRY_TRACE=1 to print every statement with its
  duration, which is how the split behind the nightly `sync_welcome` stage is read.
  """
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Operations.Probe
  alias ChalkSync.Operations.Readiness
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.TestWSClient, as: Client

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
    previous_connections = Application.get_env(:chalk_sync, :database_connections)
    connections = SyncPostgres.start_connections(@database_url)
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

    on_exit(fn ->
      Application.put_env(:chalk_sync, :stateholder, previous_stateholder)

      if previous_connections,
        do: Application.put_env(:chalk_sync, :database_connections, previous_connections),
        else: Application.delete_env(:chalk_sync, :database_connections)

      Enum.each(connections, &TestProcess.stop/1)
    end)

    {:ok, connection: hd(connections)}
  end

  setup %{connection: connection} do
    seed = SyncPostgres.seed_episode(connection, 2)
    on_exit(fn -> SyncPostgres.cleanup(connection, seed.episode) end)
    {:ok, seed: seed}
  end

  # The URL the production SDK opens: it asks Sync to own the entry, so confirmation
  # happens later on `entered` and not inside hello.
  @production_path "/v1/sync?participant_devices=1&participant_device_admissions=2&media_off_reason=1&entry_generation=new&entry_confirmation=1"

  test "a production socket entry stays within its Postgres round trip budget", ctx do
    [identity | _] = ctx.seed.identities
    statements = traced_entry(ctx.port, @production_path, identity)
    print_trace("production", statements)

    # 17 statements plus BEGIN and COMMIT for each of the admit and recovery transactions.
    assert length(statements) <= 17
  end

  test "a legacy socket entry also confirms the admission in hello", ctx do
    [identity | _] = ctx.seed.identities
    statements = traced_entry(ctx.port, "/v1/sync", identity)
    print_trace("legacy", statements)

    assert length(statements) <= 64
  end

  defp print_trace(label, statements) do
    if System.get_env("CHALK_SYNC_ENTRY_TRACE") do
      IO.puts("ENTRY_TRACE #{label} statements=#{length(statements)}")
      for {sql, micros} <- statements, do: IO.puts("ENTRY_TRACE #{label} #{micros}us #{sql}")
    end
  end

  defp traced_entry(port, path, identity) do
    {:ok, client} = Client.connect(port, path)
    wait_for_idle_probe()
    tracer = spawn_link(fn -> collect_loop([]) end)
    :erlang.trace(:all, true, [:call, :timestamp, {:tracer, tracer}])
    trace_pattern = [{:_, [], [{:return_trace}]}]
    :erlang.trace_pattern({Probe, :run, :_}, true, [:local])
    :erlang.trace_pattern({Postgrex, :query, 4}, trace_pattern, [:local])
    :erlang.trace_pattern({DBConnection, :transaction, 3}, trace_pattern, [:global])

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    assert {:json, %{"type" => "welcome"}, _client} = Client.recv(client)
    :erlang.trace(:all, false, [:call])
    :erlang.trace_pattern({Postgrex, :query, 4}, false, [:local])
    :erlang.trace_pattern({DBConnection, :transaction, 3}, false, [:global])
    :erlang.trace_pattern({Probe, :run, :_}, false, [:local])
    send(tracer, {:done, self()})
    assert_receive {:statements, statements}, 2_000
    statements
  end

  # A probe already running when tracing starts would be counted, so let it finish first.
  defp wait_for_idle_probe do
    case :sys.get_state(Readiness) do
      %{probe_pid: nil} ->
        :ok

      _running ->
        Process.sleep(10)
        wait_for_idle_probe()
    end
  end

  defp collect_loop(acc) do
    receive do
      {:done, from} -> send(from, {:statements, summarize(Enum.reverse(acc))})
      event -> collect_loop([event | acc])
    end
  end

  # Pairs each call with its return so every statement carries its duration.
  defp summarize(events) do
    # The readiness probe polls Postgres from its own process on a timer; its statements
    # are not part of the entry, so drop every process that ran the probe in the window.
    probe_pids = for {:trace_ts, pid, :call, {Probe, :run, _args}, _ts} <- events, do: pid
    events = Enum.reject(events, &(elem(&1, 1) in probe_pids))

    events
    |> Enum.reduce({[], %{}}, fn
      {:trace_ts, pid, :call, {Postgrex, :query, [_conn, sql | _]}, ts}, {done, open} ->
        {done, push(open, {pid, :query}, {label(sql), micros(ts)})}

      {:trace_ts, pid, :call, {DBConnection, :transaction, _args}, ts}, {done, open} ->
        {done, push(open, {pid, :transaction}, {"BEGIN..COMMIT", micros(ts)})}

      {:trace_ts, pid, :return_from, {Postgrex, :query, 4}, _value, ts}, acc ->
        pop(acc, {pid, :query}, micros(ts))

      {:trace_ts, pid, :return_from, {DBConnection, :transaction, 3}, _value, ts}, acc ->
        pop(acc, {pid, :transaction}, micros(ts))

      _other, acc ->
        acc
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp push(open, key, entry), do: Map.update(open, key, [entry], &[entry | &1])

  defp pop({done, open}, key, finished_at) do
    case Map.get(open, key) do
      [{sql, started} | rest] -> {[{sql, finished_at - started} | done], Map.put(open, key, rest)}
      _unmatched -> {done, open}
    end
  end

  defp label(sql) when is_binary(sql),
    do: sql |> String.split() |> Enum.take(12) |> Enum.join(" ")

  defp label(_other), do: "prepared"

  defp micros({mega, seconds, micro}), do: (mega * 1_000_000 + seconds) * 1_000_000 + micro

  defp token(identity),
    do:
      DevTokenVerifier.token(%{
        "tenant_id" => identity.episode.tenant_id,
        "space_id" => identity.episode.space_id,
        "episode_id" => identity.episode.episode_id,
        "participant_id" => identity.participant_id,
        "participant_generation" => identity.participant_generation,
        "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
        "role" => identity.role || "owner",
        "capabilities" => identity.capabilities,
        "issued_at" => 1,
        "expires_at" => 4_102_444_800
      })
end
