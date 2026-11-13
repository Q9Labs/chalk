defmodule ChalkSync.WhiteboardV1.AuthorityCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.WhiteboardV1.AuthorityCase.Repository
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority

  @participant_id "20000000-0000-4000-8000-000000000002"

  using do
    quote do
      import ChalkSync.WhiteboardV1.AuthorityCase
      alias ChalkSync.WhiteboardV1.AuthorityCase.Repository
    end
  end

  setup do
    previous = Application.get_env(:chalk_sync, :whiteboard_v1_repository)
    Application.put_env(:chalk_sync, :whiteboard_v1_repository, Repository)
    Application.put_env(:chalk_sync, :authority_test, self())
    Application.put_env(:chalk_sync, :whiteboard_authority_poll_ms, 50)
    access("active", "active")

    on_exit(fn ->
      for key <- [
            :authority_test,
            :authority_test_access,
            :authority_test_read_delay_ms,
            :whiteboard_authority_poll_ms,
            :whiteboard_authority_read_ms,
            :whiteboard_authority_stale_ms
          ],
          do: Application.delete_env(:chalk_sync, key)

      if previous,
        do: Application.put_env(:chalk_sync, :whiteboard_v1_repository, previous),
        else: Application.delete_env(:chalk_sync, :whiteboard_v1_repository)
    end)
  end

  def pollers(episode),
    do:
      Registry.lookup(
        ChalkSync.Episodes.Registry,
        {:whiteboard_authority, EpisodeKey.authority_key(episode)}
      )

  # Checks the way a busy socket does, every 5 ms, until access is no longer allowed.
  def until_not_ok(identity, connected_at \\ nil, attempts \\ 1_000) do
    case Authority.check(identity, connected_at) do
      :ok when attempts > 0 ->
        Process.sleep(5) && until_not_ok(identity, connected_at, attempts - 1)

      result ->
        result
    end
  end

  def fail_reads,
    do:
      Application.put_env(
        :chalk_sync,
        :authority_test_access,
        {:retryable, {:storage_unavailable, "timeout"}}
      )

  def access(episode_status, participant_status) do
    Application.put_env(
      :chalk_sync,
      :authority_test_access,
      {:ok,
       %{status: episode_status, participants: %{{@participant_id, 1} => participant_status}}}
    )
  end

  def drain_reads(episode, count \\ 0) do
    receive do
      {:read, ^episode} -> drain_reads(episode, count + 1)
    after
      0 -> count
    end
  end

  def wait_until(condition, attempts \\ 100) do
    cond do
      condition.() -> :ok
      attempts == 0 -> flunk("condition not met")
      true -> Process.sleep(10) && wait_until(condition, attempts - 1)
    end
  end

  def identity do
    %Identity{
      participant_id: @participant_id,
      participant_generation: 1,
      episode: %EpisodeKey{
        tenant_id: UUID.generate(),
        space_id: UUID.generate(),
        episode_id: UUID.generate()
      }
    }
  end
end
