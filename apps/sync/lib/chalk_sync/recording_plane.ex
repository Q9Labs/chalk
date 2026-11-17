defmodule ChalkSync.RecordingPlane do
  @moduledoc "Provider-neutral server-control port for durable recording operations."

  alias ChalkSync.MediaPlane
  alias ChalkSync.Stateholder.EpisodeKey

  @maximum_duration_seconds 4 * 60 * 60

  @doc "The longest recording the provider contract accepts."
  @spec maximum_duration_seconds() :: pos_integer()
  def maximum_duration_seconds, do: @maximum_duration_seconds

  @doc "Applies the facts of one provider call to the adapter."
  @callback with_call(adapter :: term(), ChalkSync.ProviderCall.t()) :: term()
  @optional_callbacks with_call: 2

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
