defmodule ChalkSync.WhiteboardV1.FileSQL do
  @moduledoc false

  # A first reference competes with cleanup on the file row. Once claimed for
  # deletion a file can't enter the scene; referenced files survive Undo/Redo.
  def reference_files do
    """
    with attached as (
      update sync_whiteboard_files
      set referenced_at = now()
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and scene_id = $4
        and file_id = any($5::text[]) and status = 'ready' and cleanup_claim_token is null
        and referenced_at is null
      returning file_id
    )
    select (select count(*) from attached) + (
      select count(*) from sync_whiteboard_files
      where tenant_id = $1 and space_id = $2 and episode_id = $3 and scene_id = $4
        and file_id = any($5::text[]) and status = 'ready' and cleanup_claim_token is null
        and referenced_at is not null
    )
    """
  end
end
