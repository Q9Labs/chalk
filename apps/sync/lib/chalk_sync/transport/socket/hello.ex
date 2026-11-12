defmodule ChalkSync.Transport.Socket.Hello do
  @moduledoc """
  The authenticated hello of a v1 socket: Identity from claims, tenant and entry admission, and the first frames.
  """

  require Logger
  alias ChalkSync.Auth.Claims
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.ProviderCall
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Telemetry
  alias ChalkSync.Transport.DirectLimits
  alias ChalkSync.Transport.Socket.Collaboration
  alias ChalkSync.Transport.Socket.Frames
  alias ChalkSync.Transport.Socket.Lifecycle
  alias ChalkSync.UUID

  def admit_direct_tenant(%{direct: nil}, _identity), do: :ok

  def admit_direct_tenant(_state, identity) do
    case DirectLimits.authenticated(identity.episode.tenant_id) do
      :ok -> :ok
      {:error, _denial} -> {:error, :direct_limit}
    end
  end


  defp confirm_legacy_entry(_identity, true), do: :ok

  defp confirm_legacy_entry(identity, false) do
    case Stateholder.confirm_admission(identity) do
      {:ok, %{result: result}} when result in [:applied, :already_applied] -> :ok
      {:ok, %{result: :superseded}} -> {:error, :invalid_admission_intent}
      error -> error
    end
  end


  defp start_registered_recovery(
         state,
         identity,
         recovery,
         coordinator,
         collaboration_negotiated,
         collaboration_version
       ) do
    activated =
      entry_stage(:activate, fn ->
        Coordinator.activate_recovery(coordinator, recovery, self(), ProviderCall.deadline_ms())
      end)

    case activated do
      :ok ->
        Process.cancel_timer(state.hello_timer)

        {:ok,
         %{
           state
           | phase: :recovering,
             hello_timer: nil,
             identity: identity,
             coordinator: coordinator,
             collaboration_negotiated: collaboration_negotiated,
             collaboration_version: collaboration_version
         }
         |> Collaboration.observe_collaboration(
           "extension.negotiate",
           Collaboration.negotiation_outcome(collaboration_negotiated)
         )}

      {:error, reason} ->
        Coordinator.unsubscribe(coordinator, self())
        Logger.warning("sync v1 recovery failed: reason=#{reason}")
        Lifecycle.stop(state, 1012, "dependency unavailable", :dependency_unavailable)

      {:retryable, reason} ->
        Coordinator.unsubscribe(coordinator, self())
        Logger.warning("sync v1 recovery retryable: #{reason}")
        Lifecycle.stop(state, 1012, "dependency unavailable", :dependency_unavailable)
    end
  end


  # Off reasons are opt-in so earlier SDKs keep their exact media wire shape.

  def identity(%Claims{} = claims) do
    with {:ok, _tenant} <- UUID.dump(claims.tenant_id),
         {:ok, _space} <- UUID.dump(claims.space_id),
         {:ok, _episode} <- UUID.dump(claims.episode_id),
         {:ok, _participant} <- UUID.dump(claims.participant_id),
         {:ok, _intent} <- UUID.dump(claims.admission_lifecycle_intent_id),
         generation when is_integer(generation) and generation > 0 <-
           claims.participant_generation,
         {:ok, authorization} <- identity_authorization(claims) do
      {:ok,
       %Identity{
         episode: %EpisodeKey{
           tenant_id: String.downcase(claims.tenant_id),
           space_id: String.downcase(claims.space_id),
           episode_id: String.downcase(claims.episode_id)
         },
         participant_id: String.downcase(claims.participant_id),
         participant_generation: generation,
         admission_lifecycle_intent_id: String.downcase(claims.admission_lifecycle_intent_id),
         protocol_version: 1,
         role: authorization.role,
         capabilities: authorization.capabilities
       }}
    else
      _ -> {:error, :invalid_identity}
    end
  end


  defp identity_authorization(%Claims{} = claims) do
    if Claims.valid_authorization?(claims.role, claims.capabilities) do
      {:ok, %{role: claims.role, capabilities: claims.capabilities}}
    else
      {:error, :invalid_authorization}
    end
  end


  # Wall time of each hello step, so the nightly `sync_welcome` stage splits into
  # database work and Episode-coordinator work.
  defp entry_stage(stage, fun), do: Telemetry.timed([:entry, :stage], stage, fun)


  defp admit_entry(state, identity) do
    entry_stage(:admit, fn ->
      Stateholder.admit_socket_entry(
        %{identity | device_type: Frames.device_type(state.connection_attributes[:user_agent])},
        state.requested_entry_generation
      )
    end)
  end


  defp negotiate_entry(state, identity, recovery, hello) do
    requested =
      if recovery.mode == :terminal or recovery.terminal_reason,
        do: nil,
        else: Map.get(hello, :collaboration)

    entry_stage(:negotiate, fn ->
      Collaboration.negotiate_collaboration(identity, requested, state.observability)
    end)
  end


  defp begin_entry_recovery(state, identity, protocol_options) do
    options =
      protocol_options
      |> Map.put(:entry_confirmation, state.entry_confirmation)
      |> Map.put(:media_off_reason, state.media_off_reason)
      |> Map.put(:connection_quality, state.connection_quality)
      |> Map.put(
        :entry_generation,
        state.requested_entry_generation != :legacy && not is_nil(identity.entry_generation)
      )

    entry_stage(:begin_recovery, fn -> Coordinator.begin_recovery(identity, self(), options) end)
  end


  def authenticated_hello(state, identity, cursor, hello) do
    with {:ok, identity} <- admit_entry(state, identity),
         state = %{
           state
           | entry_confirmation:
               state.entry_confirmation && identity.entry_ownership != :compatibility
         },
         :ok <-
           entry_stage(:confirm, fn ->
             confirm_legacy_entry(identity, state.entry_confirmation)
           end),
         {:ok, recovery} <- entry_stage(:recover, fn -> Stateholder.recover(identity, cursor) end),
         {:ok, protocol_options, negotiated?, collaboration_version} <-
           negotiate_entry(state, identity, recovery, hello),
         {:ok, coordinator} <- begin_entry_recovery(state, identity, protocol_options) do
      start_registered_recovery(
        state,
        identity,
        recovery,
        coordinator,
        negotiated?,
        collaboration_version
      )
    else
      {:error, :stale_participant_generation} ->
        Lifecycle.stop(state, 1008, "invalid token", :admission_rejected)

      {:error, :invalid_admission_intent} ->
        Lifecycle.stop(state, 1008, "policy violation", :admission_rejected)

      {:error, :entry_expired} ->
        Lifecycle.stop(state, 1008, "entry timeout", :entry_timeout)

      {:error, reason} ->
        Logger.warning("sync v1 hello failed: reason=#{reason}")

        Lifecycle.stop(state, 1012, "dependency unavailable", :dependency_unavailable)

      {:retryable, reason} ->
        Logger.warning("sync v1 hello retryable: #{reason}")
        Lifecycle.stop(state, 1012, "dependency unavailable", :dependency_unavailable)
    end
  end
end
