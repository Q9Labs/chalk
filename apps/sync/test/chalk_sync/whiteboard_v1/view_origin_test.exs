defmodule ChalkSync.WhiteboardV1.ViewOriginTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.WhiteboardV1.OriginAgreement
  alias ChalkSync.WhiteboardV1.ViewClock
  alias ChalkSync.WhiteboardV1.ViewOrigin

  @episode %EpisodeKey{tenant_id: "tenant", space_id: "space", episode_id: "episode"}
  @neutral "0:" <> String.duplicate("0", 64)

  for offset <- [-10_000_000, 10_000_000] do
    @offset offset
    test "authentic stamps advance another node despite wall skew #{offset}" do
      a =
        start_supervised!({ViewClock, name: :view_clock_test_a, wall: fn -> 20_000_000 end},
          id: :a
        )

      b =
        start_supervised!(
          {ViewClock, name: :view_clock_test_b, wall: fn -> 20_000_000 + @offset end},
          id: :b
        )

      {:ok, first} = ViewOrigin.lead(view("a"), @episode, a)
      first = Map.put(first, :origin_proof, ViewOrigin.sign(first, @episode))
      assert ViewOrigin.valid?(first, @episode, b)
      {:ok, later} = ViewOrigin.lead(view("b"), @episode, b)
      assert time(later) > time(first)
      signed = Map.put(later, :origin_proof, ViewOrigin.sign(later, @episode))
      assert ViewOrigin.valid?(signed, @episode, a)
      {:ok, third} = ViewOrigin.lead(view("a"), @episode, a)
      assert time(third) > time(later)
      idle = %{later | lead: false}
      assert {:ok, ^idle} = ViewOrigin.lead(idle, @episode, b)
      refute ViewOrigin.valid?(%{first | x: 999}, @episode, b)
    end
  end

  test "concurrent nodes issue authentic independently ordered stamps" do
    a = start_supervised!({ViewClock, name: :view_clock_test_a, wall: fn -> 100 end}, id: :a)
    b = start_supervised!({ViewClock, name: :view_clock_test_b, wall: fn -> 100 end}, id: :b)
    {:ok, first} = ViewOrigin.lead(view("a"), @episode, a)
    {:ok, second} = ViewOrigin.lead(view("b"), @episode, b)
    assert time(first) == time(second)
    signed = Map.put(second, :origin_proof, ViewOrigin.sign(second, @episode))
    assert ViewOrigin.valid?(signed, @episode, a)
    {:ok, later} = ViewOrigin.lead(view("a"), @episode, a)
    assert time(later) > time(second)
  end

  test "cached Bring can become an ordinary relay but an ordinary view cannot become Bring" do
    clock = start_supervised!({ViewClock, name: :view_clock_bring, wall: fn -> 100 end})
    {:ok, bring} = ViewOrigin.lead(%{view("a") | bring: true}, @episode, clock)
    signed_bring = Map.put(bring, :origin_proof, ViewOrigin.sign(bring, @episode))
    assert ViewOrigin.valid?(%{signed_bring | bring: false}, @episode, clock)
    refute ViewOrigin.valid?(%{signed_bring | bring: false, x: 999}, @episode, clock)
    ordinary = %{bring | bring: false}
    signed_ordinary = Map.put(ordinary, :origin_proof, ViewOrigin.sign(ordinary, @episode))
    refute ViewOrigin.valid?(%{signed_ordinary | bring: true}, @episode, clock)
  end

  test "clock capacity never evicts an active ordering watermark" do
    clock =
      start_supervised!(
        {ViewClock, name: :view_clock_test_capacity, capacity: 1, wall: fn -> 1 end}
      )

    assert {:ok, 100} = ViewClock.advance(@episode, 100, false, clock)

    assert {:error, :view_clock_capacity} =
             ViewClock.advance(%{@episode | episode_id: "other"}, 0, true, clock)

    assert {:ok, 101} = ViewClock.advance(@episode, 0, true, clock)
  end

  test "secret disagreement fails readiness and logs only fingerprints once per peer change" do
    local = ViewOrigin.fingerprint()
    peer = String.duplicate("b", 64)
    initial = OriginAgreement.new(local, 0)
    assert {:error, :view_origin_peer_discovery} = OriginAgreement.status(initial, 0)
    assert :ok = OriginAgreement.status(initial, 2000)

    log =
      capture_log(fn ->
        mismatch = OriginAgreement.observe(initial, "node-b", peer, 2000)
        mismatch = OriginAgreement.observe(mismatch, "node-b", peer, 4000)
        assert {:error, :view_origin_secret_mismatch} = OriginAgreement.status(mismatch, 9000)
        assert :ok = OriginAgreement.status(mismatch, 10_000)
        matching = OriginAgreement.observe(mismatch, "node-b", local, 5000)
        assert :ok = OriginAgreement.status(matching, 5000)
      end)

    assert log =~ "local_fingerprint=#{local} peer_fingerprint=#{peer}"
    assert length(String.split(log, "origin secret mismatch")) == 2
    refute log =~ Base.encode64(Application.fetch_env!(:chalk_sync, :view_origin_secret))
  end

  defp view(connection) do
    %{
      origin_participant_id: "participant",
      origin_connection_id: connection,
      origin_lead_stamp: @neutral,
      origin_epoch: "epoch",
      origin_sequence: 1,
      x: 1,
      y: 2,
      width: 100,
      height: 100,
      bring: false,
      lead: true
    }
  end

  defp time(view), do: view.origin_lead_stamp |> String.split(":") |> hd() |> String.to_integer()
end
