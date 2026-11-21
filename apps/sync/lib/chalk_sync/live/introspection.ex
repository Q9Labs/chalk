defmodule ChalkSync.Live.Introspection do
  @moduledoc """
  Operator live introspection for `diagnose live`: one `live_request` frame to
  each of the seat's registered live sockets that negotiated
  `live_introspection=1`, then the durable `delivery` write on its
  `live_introspection_requests` row and the `live_request.deliver` decision.

  A `chalk_live_requests` notification names the row; this module is the delivery
  runner. Sync does not poll: a lost notification leaves `delivery` null. The row
  — not the coordinators, which are disposable — is the evidence, so it carries
  no credentials and none are logged.
  """

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Obs
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID

  @query_timeout_ms 1_000

  @doc """
  Delivers the request `request_id` in `tenant`/`episode` to the seat's sockets
  that negotiated `live_introspection`, then writes `delivery`,
  `delivered_at`, `sockets`, and `unavailable_reason` on the row and records
  the `live_request.deliver` decision.
  """
  @spec deliver(String.t(), String.t(), String.t()) :: :ok
  def deliver(tenant_id, episode_id, request_id) do
    Database.guard(fn -> do_deliver(tenant_id, episode_id, request_id) end, :ok)
    :ok
  end

  @doc """
  Acknowledges `request_id` on behalf of `identity`, the authenticated socket's
  seat. Answers `{:ok, fields}` for a timely ack on that seat's own request, and
  `:dropped` for an unknown, foreign, or expired request — late acks are dropped
  silently.
  """
  @spec acknowledge(Identity.t(), String.t()) :: {:ok, map()} | :dropped
  def acknowledge(%Identity{} = identity, request_id) when is_binary(request_id) do
    Database.guard(fn -> do_acknowledge(identity, request_id) end, :dropped)
  end

  def acknowledge(_identity, _request_id), do: :dropped

  defp do_deliver(tenant_id, episode_id, request_id) do
    with {:ok, request} <- fetch_request(tenant_id, episode_id, request_id) do
      {delivery, sockets, unavailable_reason} =
        send_frames(%EpisodeKey{
          tenant_id: tenant_id,
          space_id: request.space_id,
          episode_id: episode_id
        }, request, request_id)

      record_delivery(tenant_id, episode_id, request_id, delivery, sockets, unavailable_reason)

      fields =
        %{
          live_request_id: request_id,
          tenant_id: tenant_id,
          space_id: request.space_id,
          episode_id: episode_id,
          participant_id: request.participant_id,
          delivery: delivery
        }
        |> put_present(:sockets, sockets)
        |> put_present(:unavailable_reason, unavailable_reason)

      Obs.decision("live_request.deliver", delivery, fields, unavailable_reason)
    end

    :ok
  end

  # The coordinator is the live Episode process: it owns the seat's registered
  # sockets and each socket's negotiated flags, so it both counts the seat and
  # sends the frames. A missing or dead coordinator means the Episode is not
  # live anywhere this socket layer can reach: the seat has no socket.
  defp send_frames(%EpisodeKey{} = episode, request, request_id) do
    case Coordinator.whereis(episode) do
      coordinator when is_pid(coordinator) ->
        frame = %{
          "type" => "live_request",
          "request_id" => request_id,
          "expires_at_ms" => request.expires_at_ms
        }

        case Coordinator.deliver_live_request(coordinator, request.participant_id, frame) do
          {:ok, _seat, sent} when sent > 0 -> {"delivered", sent, nil}
          {:ok, 0, _sent} -> {"target_unavailable", 0, "no_socket"}
          {:ok, _seat, 0} -> {"target_unavailable", 0, "not_negotiated"}
          {:error, _reason} -> {"target_unavailable", 0, "no_socket"}
        end

      _ ->
        {"target_unavailable", 0, "no_socket"}
    end
  end

  defp fetch_request(tenant_id, episode_id, request_id) do
    case query(
           """
           select requests.participant_id, requests.expires_at, episodes.space_id
           from live_introspection_requests requests
           join episodes on episodes.tenant_id = requests.tenant_id and episodes.id = requests.episode_id
           where requests.tenant_id = $1 and requests.episode_id = $2 and requests.id = $3
           """,
           [UUID.dump!(tenant_id), UUID.dump!(episode_id), UUID.dump!(request_id)]
         ) do
      {:ok, %{rows: [[participant, expires_at, space]]}} ->
        {:ok,
         %{
           participant_id: UUID.load!(participant),
           space_id: UUID.load!(space),
           expires_at_ms: DateTime.to_unix(expires_at, :millisecond)
         }}

      {:ok, %{rows: []}} ->
        :error

      {:error, _reason} ->
        :error
    end
  end

  # First write wins: the row's `delivery` copies the decision once. `delivered_at`
  # is the delivery decision's commit time and `sockets` the count that took the
  # frame — zero when the seat could not be reached.
  defp record_delivery(tenant_id, episode_id, request_id, delivery, sockets, unavailable_reason) do
    _result =
      query(
        """
        update live_introspection_requests
        set delivery = $4, delivered_at = now(), sockets = $5, unavailable_reason = $6
        where tenant_id = $1 and episode_id = $2 and id = $3 and delivery is null
        """,
        [
          UUID.dump!(tenant_id),
          UUID.dump!(episode_id),
          UUID.dump!(request_id),
          delivery,
          sockets,
          unavailable_reason
        ]
      )

    :ok
  end

  defp do_acknowledge(%Identity{} = identity, request_id) do
    with {:ok, request} <- UUID.dump(request_id) do
      case query(
             """
             select requests.participant_id, episodes.space_id
             from live_introspection_requests requests
             join episodes on episodes.tenant_id = requests.tenant_id and episodes.id = requests.episode_id
             where requests.id = $1 and requests.tenant_id = $2 and requests.episode_id = $3
               and requests.participant_id = $4 and requests.expires_at > now()
             """,
             [
               request,
               UUID.dump!(identity.episode.tenant_id),
               UUID.dump!(identity.episode.episode_id),
               UUID.dump!(identity.participant_id)
             ]
           ) do
        {:ok, %{rows: [[participant, space]]}} ->
          {:ok,
           %{
             live_request_id: request_id,
             tenant_id: identity.episode.tenant_id,
             space_id: UUID.load!(space),
             episode_id: identity.episode.episode_id,
             participant_id: UUID.load!(participant)
           }}

        _other ->
          :dropped
      end
    else
      :error -> :dropped
    end
  end

  defp query(statement, params) do
    Postgrex.query(Database.connection_for(:background), statement, params,
      timeout: @query_timeout_ms
    )
  end

  defp put_present(fields, _key, nil), do: fields
  defp put_present(fields, key, value), do: Map.put(fields, key, value)
end
