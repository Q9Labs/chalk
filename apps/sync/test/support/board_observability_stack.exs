defmodule ChalkSync.BoardObservabilityStack do
  alias ChalkSync.Auth.DevTokenVerifier
  alias ChalkSync.Database
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  def run do
    Application.put_env(:chalk_sync, :database_url, SyncPostgres.database_url!())
    Application.put_env(:chalk_sync, :database_pool_size, 4)
    Application.put_env(:chalk_sync, :port, :none)
    Application.put_env(:chalk_sync, :database_workers, true)
    {:ok, _apps} = Application.ensure_all_started(:chalk_sync)

    {:ok, listener} =
      Bandit.start_link(
        plug: ChalkSync.Transport.Router,
        ip: {127, 0, 0, 1},
        port: 0,
        websocket_options: ChalkSync.Application.websocket_options()
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)
    root = Path.expand("../../../..", __DIR__)
    scratch = Path.join(System.tmp_dir!(), "chalk-board-" <> UUID.generate())
    File.mkdir!(scratch)
    rows = :ets.new(:board_observability, [:public, :duplicate_bag])

    :telemetry.attach(
      __MODULE__,
      [:chalk_sync, :obs, :record],
      &__MODULE__.collect/4,
      rows
    )

    try do
      for fault <-
            ~w(healthy board.edit_not_committed board.out_of_sync board.draw_denied board.snapshot_mismatch) do
        scenario(port, root, scratch, rows, fault)
      end
    after
      :telemetry.detach(__MODULE__)
      File.rm_rf!(scratch)
      GenServer.stop(listener)
      Application.stop(:chalk_sync)
    end
  end

  def collect(
        _event,
        _measurements,
        %{"name" => "board." <> _, "episode_id" => episode} = row,
        table
      ) do
    :ets.insert(table, {episode, row})
  end

  def collect(_event, _measurements, _row, _table), do: :ok

  defp scenario(port, root, scratch, rows, fault) do
    selector = %ChalkSync.Stateholder.EpisodeKey{
      tenant_id: "board-proof",
      space_id: "board-proof",
      episode_id: "board-proof"
    }

    connection = Database.connection(selector)

    fixture =
      SyncPostgres.seed_episode(connection, 3, %{}, %{
        participants: [%{role: "owner"}, %{role: "collaborator"}, %{role: "collaborator"}]
      })

    episode = fixture.episode
    input = Path.join(scratch, "input.json")
    output = Path.join(scratch, "output.json")
    capture = Path.join(scratch, "capture.json")
    seats = Enum.map(fixture.identities, &%{participant: &1.participant_id, token: token(&1)})

    try do
      File.write!(
        input,
        JSON.encode!(%{
          url: "ws://127.0.0.1:#{port}/v1/whiteboard",
          tenant: episode.tenant_id,
          episode: episode.episode_id,
          seats: seats,
          fault: fault
        })
      )

      script = "sdks/typescript/client/tests/board-observability.fault.ts"

      {result, status} =
        System.cmd("pnpm", ["exec", "tsx", script, input, output],
          cd: root,
          stderr_to_stdout: true
        )

      if status != 0, do: raise("#{fault} driver failed:\n#{result}")

      client = output |> File.read!() |> JSON.decode!()
      sync = :ets.lookup(rows, episode.episode_id) |> Enum.map(&elem(&1, 1))

      File.write!(
        capture,
        JSON.encode!(%{
          fault: fault,
          tenant: episode.tenant_id,
          episode: episode.episode_id,
          seats: Enum.map(seats, & &1.participant),
          from: client["from"] - 100,
          to: client["to"] + 100,
          rows: client["rows"] ++ sync
        })
      )

      {result, status} =
        System.cmd("node", ["scripts/diagnose-call/fixtures/board-stack.mjs", capture],
          cd: root,
          stderr_to_stdout: true
        )

      IO.puts(result)
      if status != 0, do: raise("#{fault} diagnosis failed")
    after
      SyncPostgres.cleanup(connection, episode)
    end
  end

  defp token(identity) do
    DevTokenVerifier.token(%{
      "tenant_id" => identity.episode.tenant_id,
      "space_id" => identity.episode.space_id,
      "episode_id" => identity.episode.episode_id,
      "participant_id" => identity.participant_id,
      "participant_generation" => identity.participant_generation,
      "admission_lifecycle_intent_id" => identity.admission_lifecycle_intent_id,
      "role" => identity.role,
      "capabilities" => identity.capabilities,
      "issued_at" => 1,
      "expires_at" => 4_102_444_800
    })
  end
end

ChalkSync.BoardObservabilityStack.run()
