defmodule ChalkSync.RecordingPlane do
  @moduledoc "Provider-neutral server-control port for durable recording operations."

  alias ChalkSync.MediaPlane
  alias ChalkSync.Stateholder.EpisodeKey

  @callback start_recording(
              adapter :: term(),
              operation_id :: String.t(),
              EpisodeKey.t(),
              recording_id :: String.t()
            ) :: MediaPlane.outcome()
  @callback stop_recording(
              adapter :: term(),
              operation_id :: String.t(),
              EpisodeKey.t(),
              recording_id :: String.t()
            ) :: MediaPlane.outcome()
end
