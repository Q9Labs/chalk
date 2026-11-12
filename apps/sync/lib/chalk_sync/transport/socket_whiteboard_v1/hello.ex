defmodule ChalkSync.Transport.SocketWhiteboardV1.Hello do
  @moduledoc """
  The authenticated hello of a whiteboard-v1 socket: Identity from claims, welcome frame, extension negotiation.
  """

  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Auth.Claims
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Authority.Reads
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.Protocol
  alias ChalkSync.WhiteboardV1.ViewOwner

  def identity(
        %Claims{
          tenant_id: tenant_id,
          space_id: space_id,
          episode_id: episode_id,
          participant_id: participant_id,
          participant_generation: generation
        } = claims
      )
      when is_binary(tenant_id) and is_binary(space_id) and is_binary(episode_id) and
             is_binary(participant_id) and is_integer(generation) and generation > 0 do
    {:ok,
     %Identity{
       episode: %EpisodeKey{tenant_id: tenant_id, space_id: space_id, episode_id: episode_id},
       participant_id: participant_id,
       participant_generation: generation,
       admission_lifecycle_intent_id: claims.admission_lifecycle_intent_id,
       role: claims.role,
       capabilities: claims.capabilities
     }}
  end

  def identity(_claims) do
    {:error, :invalid_identity}
  end

  def authenticated_hello(state, identity, claims, requested_extensions) do
    extensions = Extensions.parse(requested_extensions)

    with {:ok, welcome} <- Episode.connect(identity),
         # Taken once the connect check has passed, so a stored read that started while it waited,
         # possibly before the Participant's admission committed, cannot close this socket.
         connected_at = System.monotonic_time(:millisecond),
         :ok <- Authority.watch(identity.episode),
         {:ok, owner, owner_id, _views} <-
           ViewOwner.join(identity.episode, identity.participant_id) do
      Process.cancel_timer(state.hello_timer)
      Fanout.subscribe(identity.episode)
      Process.send_after(self(), :whiteboard_authority_tick, Reads.poll_ms())
      welcome = negotiated_welcome(welcome, extensions, owner_id)

      next =
        %{
          state
          | phase: :live,
            hello_timer: nil,
            identity: identity,
            connected_at: connected_at,
            display_name: claims.display_name,
            extensions: extensions,
            can_draw: welcome["can_draw"],
            view_owner: owner,
            view_owner_ref: Process.monitor(owner),
            scene_id: welcome["scene_id"],
            revision: String.to_integer(welcome["revision"])
        }
        |> Lifecycle.observe_operation("connect", "accepted")

      send(self(), :whiteboard_v1_access_changed)
      {:push, {:text, Protocol.encode!(welcome)}, next}
    else
      {:error, :permission_denied} ->
        Lifecycle.stop(state, 1008, "policy violation", :permission_denied)

      {:error, :authority_unavailable} ->
        Lifecycle.dependency_unavailable(state, "authority")

      _unavailable ->
        Lifecycle.stop(state, 1012, "dependency unavailable", :dependency_unavailable)
    end
  end

  defp negotiated_welcome(welcome, extensions, owner_id) do
    welcome
    |> keep_unless(Extensions.presentation?(extensions), "presenting")
    |> keep_unless(Extensions.presenter?(extensions), "presenter_id")
    |> put_if(Extensions.view_owner?(extensions), "view_owner_id", owner_id)
  end

  defp keep_unless(welcome, true, _key), do: welcome
  defp keep_unless(welcome, false, key), do: Map.delete(welcome, key)

  defp put_if(welcome, true, key, value), do: Map.put(welcome, key, value)
  defp put_if(welcome, false, _key, _value), do: welcome
end
