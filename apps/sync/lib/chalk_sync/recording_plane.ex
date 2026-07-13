defmodule ChalkSync.RecordingPlane do
  @moduledoc "Provider-neutral server-control port for durable recording operations."

  alias ChalkSync.MediaPlane
  alias ChalkSync.Stateholder.SessionKey

  @callback start_recording(
              adapter :: term(),
              operation_id :: String.t(),
              SessionKey.t(),
              recording_id :: String.t()
            ) :: MediaPlane.outcome()
  @callback stop_recording(
              adapter :: term(),
              operation_id :: String.t(),
              SessionKey.t(),
              recording_id :: String.t()
            ) :: MediaPlane.outcome()
end
