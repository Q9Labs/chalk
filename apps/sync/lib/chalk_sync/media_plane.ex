defmodule ChalkSync.MediaPlane do
  @moduledoc """
  Provider-neutral server-control port for observed media publications.

  Granting publication changes server-side permission only. Enabling local
  capture is deliberately absent from this behavior because it remains a
  client-runtime consent action.

  Observation cursors must be monotonic for a Session. `sequence` increases
  within one provider `incarnation`; after an observer restart, the adapter
  must use an `incarnation` greater than every incarnation it previously
  exposed. Repeated cursors must carry the same publication snapshot.
  """

  alias ChalkSync.Stateholder.SessionKey

  @type source :: :microphone | :camera | :screen
  @type outcome ::
          :confirmed
          | :satisfied
          | {:retryable_failure, atom()}
          | {:terminal_failure, atom()}
          | :ambiguous
  @type publication :: %{
          participant_session_id: String.t(),
          source: source(),
          enabled: boolean(),
          publication_id: String.t() | nil
        }
  @type observation :: %{
          incarnation: non_neg_integer(),
          sequence: non_neg_integer(),
          publications: [publication()]
        }

  @callback grant_publication(
              adapter :: term(),
              operation_id :: String.t(),
              SessionKey.t(),
              participant_session_id :: String.t(),
              source()
            ) :: outcome()
  @callback revoke_publication(
              adapter :: term(),
              operation_id :: String.t(),
              SessionKey.t(),
              participant_session_id :: String.t(),
              source()
            ) :: outcome()
  @callback remove_participant(
              adapter :: term(),
              operation_id :: String.t(),
              SessionKey.t(),
              participant_session_id :: String.t()
            ) :: outcome()
  @callback end_session(
              adapter :: term(),
              operation_id :: String.t(),
              SessionKey.t()
            ) :: outcome()
  @callback observe_session_publications(adapter :: term(), SessionKey.t()) ::
              {:ok, observation()} | {:error, atom()}
end
