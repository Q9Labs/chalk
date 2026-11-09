defmodule ChalkSync.Transport.EntryRoundTripsTest do
  @moduledoc """
  Counts the Postgres statements a socket entry (hello until welcome) sends, one
  round trip each. Set CHALK_SYNC_ENTRY_TRACE=1 to print every statement with its
  duration, which is how the split behind the nightly `sync_welcome` stage is read.
  """
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Auth.DevTokenVerifier
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

  test "a first socket entry stays within its Postgres round trip budget", ctx do
    [identity | _] = ctx.seed.identities
    statements = traced_entry(ctx.port, identity)

    if System.get_env("CHALK_SYNC_ENTRY_TRACE") do
      for {sql, micros} <- statements, do: IO.puts("ENTRY_TRACE #{micros}us #{sql}")
    end

    assert length(statements) <= 64
  end

  defp traced_entry(port, identity) do
    {:ok, client} = Client.connect(port, "/v1/sync")
    collector = start_collector()
    :dbg.tracer(:process, {fn message, state -> collect(message, state, collector) end, %{}})
    :dbg.p(:all, [:call, :timestamp])
    :dbg.tpl(Postgrex, :query, 4, [{:_, [], [{:return_trace}]}])
    :dbg.tpl(DBConnection, :transaction, 3, [{:_, [], [{:return_trace}]}])

    client =
      Client.send_json(client, %{
        "type" => "hello",
        "protocol" => 1,
        "token" => token(identity),
        "streams" =>
          Map.new(["control", "media", "presence", "requests"], &{&1, %{"cursor" => nil}})
      })

    assert {:json, %{"type" => "welcome"}, _client} = Client.recv(client)
    :dbg.stop()
    send(collector, {:done, self()})
    assert_receive {:statements, statements}, 2_000
    statements
  end

  defp start_collector do
    spawn_link(fn -> collect_loop([]) end)
  end

  defp collect_loop(acc) do
    receive do
      {:call, entry} -> collect_loop([entry | acc])
      {:done, from} -> send(from, {:statements, summarize(Enum.reverse(acc))})
    end
  end

  # Pairs each call with its return so every statement carries its duration.
  defp summarize(events) do
    events
    |> Enum.reduce({[], %{}}, fn
      {:call, pid, kind, sql, at}, {done, open} ->
        {done, Map.update(open, {pid, kind}, [{sql, at}], &[{sql, at} | &1])}

      {:return, pid, kind, at}, {done, open} ->
        case Map.get(open, {pid, kind}) do
          [{sql, started} | rest] ->
            {[{sql, at - started} | done], Map.put(open, {pid, kind}, rest)}

          _unmatched ->
            {done, open}
        end
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp collect({:trace_ts, pid, :call, {Postgrex, :query, [_conn, sql | _]}, ts}, state, collector) do
    send(collector, {:call, {:call, pid, :query, label(sql), micros(ts)}})
    state
  end

  defp collect({:trace_ts, pid, :call, {DBConnection, :transaction, _args}, ts}, state, collector) do
    send(collector, {:call, {:call, pid, :transaction, "BEGIN..COMMIT", micros(ts)}})
    state
  end

  defp collect({:trace_ts, pid, :return_from, {Postgrex, :query, 4}, _value, ts}, state, collector) do
    send(collector, {:call, {:return, pid, :query, micros(ts)}})
    state
  end

  defp collect(
         {:trace_ts, pid, :return_from, {DBConnection, :transaction, 3}, _value, ts},
         state,
         collector
       ) do
    send(collector, {:call, {:return, pid, :transaction, micros(ts)}})
    state
  end

  defp collect(_message, state, _collector), do: state

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
