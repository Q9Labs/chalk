defmodule ChalkSync.Stateholder.OperationTable do
  @moduledoc """
  The one list of external-operation names.

  Each row says how a name is spelled in storage, whether intake accepts it, which plane runs it
  and which media sources it revokes. Adding an operation is one row here plus its payload
  validation in `Operation` and its fact in the finalizer.
  """

  @type name :: atom()
  @type plane :: :local | :media | :recording | :episode_end | :none
  @type source :: :microphone | :camera | :screen

  # Planes: `:local` changes only Sync's database, `:media` and `:recording` call that provider,
  # `:episode_end` cleans up both, `:none` is never dispatched.
  @rows [
    %{name: :admit_participant, plane: :local, intake: true},
    %{name: :deny_admission, plane: :local, intake: true},
    %{name: :admission_request_expired, plane: :local, intake: true},
    %{name: :mute_participant, plane: :media, intake: true, sources: [:microphone]},
    %{name: :stop_participant_camera, plane: :media, intake: true, sources: [:camera]},
    %{name: :stop_participant_screen_share, plane: :media, intake: true, sources: [:screen]},
    %{
      name: :remove_participant,
      plane: :media,
      intake: true,
      sources: [:microphone, :camera, :screen]
    },
    %{name: :start_recording, plane: :recording, intake: true},
    %{name: :stop_recording, plane: :recording, intake: true},
    %{name: :recording_capture_ready, plane: :local, intake: true},
    %{name: :recording_capture_stopped, plane: :local, intake: true},
    %{name: :recording_capture_failed, plane: :local, intake: true},
    %{name: :participant_leave, plane: :local, intake: true},
    %{name: :start_episode, plane: :none, intake: true, stored: false},
    %{name: :extend_episode, plane: :none, intake: true, stored: false},
    %{name: :end_episode, plane: :episode_end, intake: true},
    %{name: :tenant_set_deadline, plane: :local, intake: true},
    %{name: :tenant_end_episode, plane: :episode_end, intake: true},
    %{
      name: :maximum_duration_expired,
      plane: :episode_end,
      intake: true,
      stored_as: "maximum_episode_duration_expired"
    },
    %{name: :tenant_assign_roles, plane: :none},
    %{name: :role_transition_cleanup, plane: :none},
    %{name: :role_transition_source_stop, plane: :media}
  ]

  @local_names for %{plane: :local, name: name} <- @rows, do: name
  @media_names for %{plane: :media, name: name} <- @rows, do: name
  @recording_names for %{plane: :recording, name: name} <- @rows, do: name
  @episode_end_names for %{plane: :episode_end, name: name} <- @rows, do: name

  defguard is_local_name(name) when name in @local_names
  defguard is_media_name(name) when name in @media_names
  defguard is_recording_name(name) when name in @recording_names
  defguard is_episode_end_name(name) when name in @episode_end_names

  @spec local_names() :: [name()]
  def local_names, do: @local_names

  @spec episode_end_names() :: [name()]
  def episode_end_names, do: @episode_end_names

  @spec stored_name(name()) :: String.t()
  for %{name: name} = row <- @rows do
    def stored_name(unquote(name)), do: unquote(Map.get(row, :stored_as, Atom.to_string(name)))
  end

  @stored Map.new(
            for(
              row <- @rows,
              Map.get(row, :stored, true),
              do: {Map.get(row, :stored_as, Atom.to_string(row.name)), row.name}
            )
          )

  @doc "Reads a stored name back to its atom."
  @spec from_stored(String.t()) :: {:ok, name()} | :error
  def from_stored(stored), do: Map.fetch(@stored, stored)

  # Intake accepts the atom's own spelling, and also the spelling storage uses.
  @intake Map.new(
            for(
              row <- @rows,
              Map.get(row, :intake, false),
              spelling <-
                Enum.uniq([
                  Atom.to_string(row.name),
                  Map.get(row, :stored_as, Atom.to_string(row.name))
                ]),
              do: {spelling, row.name}
            )
          )

  @intake_names for %{intake: true, name: name} <- @rows, do: name

  @spec intake_name?(atom()) :: boolean()
  def intake_name?(name), do: name in @intake_names

  @doc "Reads a name submitted to intake."
  @spec from_intake(String.t()) :: {:ok, name()} | :error
  def from_intake(submitted), do: Map.fetch(@intake, submitted)

  @spec plane(name()) :: plane()
  for %{name: name, plane: plane} <- @rows do
    def plane(unquote(name)), do: unquote(plane)
  end

  @doc "Media sources an operation revokes, in the order the provider is called."
  @spec sources(name()) :: [source()]
  for %{name: name} = row <- @rows, Map.has_key?(row, :sources) do
    def sources(unquote(name)), do: unquote(row.sources)
  end

  def sources(_name), do: []
end
