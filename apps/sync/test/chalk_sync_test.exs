defmodule ChalkSyncTest do
  use ExUnit.Case, async: true

  test "supervision tree is running with core children" do
    children = Supervisor.which_children(ChalkSync.Supervisor)
    ids = Enum.map(children, fn {id, _pid, _type, _mods} -> id end)

    assert ChalkSync.Rooms.Registry in ids
    assert ChalkSync.Rooms.Supervisor in ids
    assert ChalkSync.Stateholder.Memory in ids
    assert ChalkSync.DevTools.TraceHub in ids
  end
end
