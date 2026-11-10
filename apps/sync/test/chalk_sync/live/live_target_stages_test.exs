defmodule ChalkSync.Live.LiveTargetStagesTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Operations.Metrics
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  defmodule StubStateholder do
    @moduledoc false

    def participant_authority(_episode, participant_id, _generation),
      do: {:ok, %{participant_id: participant_id, generation: 1, capabilities: ["publishAudio"]}}

    def reserve_publication_grant(_identity, _operation_id, _source),
      do: {:ok, %{reservation_id: "reservation", control_revision: 1}}

    def complete_publication_grant(_episode, _reservation_id, _outcome),
      do: {:ok, %{result: :authorized}}

    def set_media_pause(_identity, _source, _publication_id), do: :ok
  end

  defmodule StubMediaPlane do
    @moduledoc false

    def grant_publication(_adapter, _operation_id, _episode, _participant_id, _source),
      do: :confirmed
  end

  setup do
    previous =
      {Application.fetch_env!(:chalk_sync, :stateholder),
       Application.get_env(:chalk_sync, :media_plane)}

    Application.put_env(:chalk_sync, :stateholder, StubStateholder)
    Application.put_env(:chalk_sync, :media_plane, {StubMediaPlane, :adapter})

    on_exit(fn ->
      {stateholder, media_plane} = previous
      Application.put_env(:chalk_sync, :stateholder, stateholder)

      if media_plane,
        do: Application.put_env(:chalk_sync, :media_plane, media_plane),
        else: Application.delete_env(:chalk_sync, :media_plane)
    end)

    :ok
  end

  test "enabling a source times each step that runs before the sender may publish" do
    ref = make_ref()
    parent = self()

    :telemetry.attach(
      {__MODULE__, ref},
      [:chalk, :sync, :live_target, :stage],
      fn _event, %{duration_us: duration_us}, %{stage: stage}, _config ->
        send(parent, {:stage, stage, duration_us})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach({__MODULE__, ref}) end)

    episode = %EpisodeKey{tenant_id: "tenant", space_id: "space", episode_id: "episode"}
    identity = %Identity{episode: episode, participant_id: "p1", participant_generation: 1}
    target = %{operation_id: "op-1", name: :set_microphone_enabled, enabled: true}

    assert {_state, %{"outcome" => "confirmed"}} =
             LiveEpisode.live_target(LiveEpisode.new(episode), identity, target)

    for stage <- [:reserve, :grant, :complete, :clear_pause] do
      assert_received {:stage, ^stage, duration_us} when is_integer(duration_us)
    end
  end

  test "the metrics snapshot keeps one fixed-cardinality entry per stage" do
    :ok =
      ChalkSync.Telemetry.execute([:live_target, :stage], %{duration_us: 1_500}, %{
        outcome: :success,
        stage: :grant
      })

    :ok =
      ChalkSync.Telemetry.execute([:live_target, :stage], %{duration_us: 9}, %{
        outcome: :success,
        stage: "caller-chosen"
      })

    %{metrics: metrics} = Metrics.snapshot()

    assert %{count: count, total_duration_us: total} =
             metrics["chalk.sync.live_target.stage.success.grant"]

    assert count >= 1 and total >= 1_500
    refute Enum.any?(Map.keys(metrics), &String.contains?(&1, "caller-chosen"))
  end

  test "a timed socket entry step lands in its own fixed label" do
    assert :done = ChalkSync.Telemetry.timed([:entry, :stage], :recover, fn -> :done end)

    assert :done =
             ChalkSync.Telemetry.timed([:entry, :stage], :not_a_stage, fn -> :done end)

    %{metrics: metrics} = Metrics.snapshot()

    assert %{count: count} = metrics["chalk.sync.entry.stage.success.recover"]
    assert count >= 1
    refute Enum.any?(Map.keys(metrics), &String.contains?(&1, "not_a_stage"))
  end
end
