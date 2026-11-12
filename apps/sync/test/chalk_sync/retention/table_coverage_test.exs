defmodule ChalkSync.Retention.TableCoverageTest do
  @moduledoc """
  Every `sync_*` table in the migrated schema is deleted by Retention, removed by a cascade from
  a table Retention deletes, or listed below with the reason its rows stay. A new table that is
  none of these fails here, so its rows cannot outlive the retention promise unnoticed.
  """

  use ChalkSync.PostgresCase

  @kept %{
    # Singleton rows for rollout and recovery state; they hold no Episode data.
    "sync_entry_rollout" => :singleton,
    "sync_presence_runtime" => :singleton,
    # Retention checkpoints this row and keeps it as the Episode's tombstone and attendance anchor.
    "sync_episode_control" => :checkpointed,
    # The API deletes a row after it removes the stored object; Retention keeps the chat stream
    # until no attachment is left.
    "sync_chat_attachments" => :deleted_by_api
  }

  @retention_source Path.expand("../../../lib/chalk_sync/retention/sql.ex", __DIR__)

  @cascade_edges """
  select child.relname, parent.relname
  from pg_constraint constraint_row
  join pg_class child on child.oid = constraint_row.conrelid
  join pg_class parent on parent.oid = constraint_row.confrelid
  where constraint_row.contype = 'f' and constraint_row.confdeltype = 'c'
  """

  test "every sync table is deleted, cascaded or kept for a stated reason", %{
    connection: connection
  } do
    deleted = deleted_tables()
    cascaded = cascaded_from(connection, deleted)
    covered = MapSet.new(deleted ++ cascaded ++ Map.keys(@kept))

    uncovered =
      connection
      |> sync_tables()
      |> Enum.reject(&MapSet.member?(covered, &1))

    assert uncovered == []
  end

  test "retention and the kept list name only tables that exist", %{connection: connection} do
    assert (deleted_tables() ++ Map.keys(@kept)) -- sync_tables(connection) == []
  end

  defp sync_tables(connection) do
    %{rows: rows} =
      Postgrex.query!(
        connection,
        "select tablename from pg_tables where schemaname = current_schema() and tablename like 'sync\\_%' order by 1",
        []
      )

    List.flatten(rows)
  end

  defp deleted_tables do
    source = File.read!(@retention_source)

    ~r/(?:delete from|delete_rows\(")\s*(sync_[a-z_]+)/
    |> Regex.scan(source, capture: :all_but_first)
    |> List.flatten()
    |> Enum.uniq()
  end

  defp cascaded_from(connection, roots) do
    %{rows: edges} = Postgrex.query!(connection, @cascade_edges, [])
    reach(roots, edges, MapSet.new()) |> MapSet.to_list()
  end

  defp reach([], _edges, seen), do: seen

  defp reach(frontier, edges, seen) do
    children =
      for [child, parent] <- edges, parent in frontier, not MapSet.member?(seen, child), do: child

    reach(Enum.uniq(children), edges, MapSet.union(seen, MapSet.new(children)))
  end
end
