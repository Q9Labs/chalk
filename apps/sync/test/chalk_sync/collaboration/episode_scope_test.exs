defmodule ChalkSync.Collaboration.EpisodeScopeTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Chat.Repository.SQL, as: ChatSQL
  alias ChalkSync.WhiteboardV1.SQL, as: WhiteboardSQL

  test "chat history queries require the exact Episode" do
    assert ChatSQL.read_head() =~ "episode_id = $3"
    assert ChatSQL.read_newer_page() =~ "message.episode_id = $3"
    assert ChatSQL.read_older_page() =~ "message.episode_id = $3"
  end

  test "whiteboard current-scene queries require the exact Episode" do
    for statement <- [
          WhiteboardSQL.ensure_scene(),
          WhiteboardSQL.lock_scene(),
          WhiteboardSQL.retire_scene(),
          WhiteboardSQL.update_presentation()
        ] do
      assert statement =~ "episode_id = $3"
    end

    assert WhiteboardSQL.ensure_scene() =~ "tenant_id, space_id, episode_id, scene_id"

    assert WhiteboardSQL.insert_scene() =~
             "tenant_id, space_id, episode_id, scene_id"
  end
end
