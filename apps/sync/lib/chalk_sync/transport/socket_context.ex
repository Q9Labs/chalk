defmodule ChalkSync.Transport.SocketContext do
  @moduledoc "Bounded request and verified identity fields for socket lifecycle evidence."
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.Identity

  def request(conn) do
    edge_ip = conn |> Plug.Conn.get_req_header("cf-connecting-ip") |> List.first()

    ip =
      case edge_ip && :inet.parse_address(String.to_charlist(edge_ip)) do
        {:ok, address} -> address
        _unknown -> conn.remote_ip
      end

    agent = conn |> Plug.Conn.get_req_header("user-agent") |> List.first()

    %{
      client_ip: ip |> :inet.ntoa() |> to_string(),
      user_agent: agent && String.slice(agent, 0, 512),
      close_code: nil
    }
  end

  def authenticated(state, %Identity{} = identity) do
    fields =
      Map.merge(state.connection_attributes, %{
        tenant_id: identity.episode.tenant_id,
        episode_id: identity.episode.episode_id,
        participant_id: identity.participant_id
      })

    observability =
      Observability.phase(state.observability, "sync.websocket.authenticated", fields)

    %{state | observability: observability, connection_attributes: fields}
  end
end
