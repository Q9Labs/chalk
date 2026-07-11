defmodule ChalkSync.SyncBreaker.RandomWireCampaignTest do
  use ChalkSync.ServerCase, async: false

  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.SyncBreaker.RandomWireCampaign

  test "executes a reproducible multi-client campaign against the real wire", %{port: port} do
    result = RandomWireCampaign.run_case(port, 872_193, participants: 3, steps: 30)

    assert result.status in [:pass, :fail]
    assert result.seed == 872_193
    assert result.trace != []
    assert RoomServer.whereis(result.evidence["room_id"]) == nil
  end
end
