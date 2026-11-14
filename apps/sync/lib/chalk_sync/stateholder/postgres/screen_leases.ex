defmodule ChalkSync.Stateholder.Postgres.ScreenLeases do
  @moduledoc """
  The Stateholder entry points for screen-share leases: picks the Episode's connection and runs the
  lease statements on it.
  """

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.ScreenShareLease

  def acquire_screen_lease(%EpisodeKey{} = episode, participant_id, generation, options) do
    with_connection(
      episode,
      &ScreenShareLease.acquire(&1, episode, participant_id, generation, options)
    )
  end

  def renew_screen_lease(%EpisodeKey{} = episode, lease, options) do
    with_connection(episode, &ScreenShareLease.renew(&1, episode, lease, options))
  end

  def release_screen_lease(%EpisodeKey{} = episode, lease) do
    with_connection(episode, &ScreenShareLease.release(&1, episode, lease))
  end

  defp with_connection(episode, fun) do
    if Application.get_env(:chalk_sync, :database_connections) ||
         Process.whereis(ChalkSync.Database.Registry) do
      fun.(Database.connection(episode))
    else
      {:error, :dependency_unavailable}
    end
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end
end
