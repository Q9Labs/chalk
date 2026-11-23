defmodule ChalkSync.ScreenAnnotation.Proof do
  @moduledoc false
  import ExUnit.Assertions

  alias ChalkSync.ScreenAnnotation.Availability
  alias ChalkSync.Stateholder.Postgres.ScreenShareLease
  alias ChalkSync.UUID

  def set_availability(connection, enabled) do
    Postgrex.query!(
      connection,
      """
      insert into screen_annotation_settings (singleton, enabled) values (true, $1)
      on conflict (singleton) do update set enabled = excluded.enabled
      """,
      [enabled]
    )

    await_availability(enabled)
  end

  def clear_availability(connection) do
    Postgrex.query!(connection, "delete from screen_annotation_settings where singleton", [])
  end

  def await_availability(enabled) do
    assert Enum.any?(1..150, fn _ ->
             Availability.enabled?() == enabled or (Process.sleep(20) && false)
           end)
  end

  def publish_screen(host, connection, cleanup) do
    {:ok, _lease} =
      ScreenShareLease.acquire(
        connection,
        host.episode,
        host.participant_id,
        host.participant_generation
      )

    publication = publication(host.participant_generation, "screen-1")
    observe(connection, host, 1, publication)

    cleanup.(fn ->
      params = [uuid(host.episode.tenant_id), uuid(host.episode.episode_id)]

      Postgrex.query!(
        connection,
        "delete from sync_screen_annotation_layers where tenant_id = $1 and episode_id = $2",
        params
      )

      cleanup_journey(connection, host.episode.episode_id)

      Postgrex.query!(
        connection,
        "delete from provider_operation_observations where tenant_id = $1 and episode_id = $2",
        params
      )

      Postgrex.query!(
        connection,
        "delete from provider_operation_observation_heads where tenant_id = $1 and episode_id = $2",
        params
      )
    end)

    %{publication: publication}
  end

  def observe(connection, host, sequence, publication) do
    params = [uuid(host.episode.tenant_id), uuid(host.episode.episode_id), sequence]

    publications = [
      %{
        "participant_id" => host.participant_id,
        "source" => "screen",
        "enabled" => true,
        "publication_id" => publication
      }
    ]

    assert {:ok, _} =
             Postgrex.transaction(connection, fn tx ->
               Postgrex.query!(
                 tx,
                 """
                 insert into provider_operation_observation_heads (tenant_id, episode_id, incarnation, sequence)
                 values ($1, $2, 1, $3) on conflict (tenant_id, episode_id) do update set sequence = excluded.sequence
                 """,
                 params
               )

               Postgrex.query!(
                 tx,
                 """
                 insert into provider_operation_observations
                   (tenant_id, episode_id, incarnation, sequence, publications, observation_fingerprint)
                 values ($1, $2, 1, $3, $4, decode(repeat('00', 32), 'hex'))
                 """,
                 params ++ [publications]
               )
             end)
  end

  def publication(generation, track) do
    "chalk_pub_v1." <>
      Base.url_encode64(
        JSON.encode!(%{"c" => "session", "t" => track, "g" => generation, "m" => "1"}),
        padding: false
      )
  end

  defp cleanup_journey(connection, episode) do
    Postgrex.query!(
      connection,
      "delete from observability_journey_events where attributes->>'episodeId' = $1",
      [episode]
    )
  end

  def assert_lifecycle_evidence(connection, episode, layer) do
    result =
      Postgrex.query!(
        connection,
        """
        select event_id, parent_event_id, journey_id::text, name, trace_id, attributes
        from observability_journey_events
        where attributes->>'layerId' = $1
        order by sequence
        """,
        [layer]
      )

    assert [
             [opened, nil, ^episode, "screen_annotation.opened", trace, opened_attributes],
             [_, opened, ^episode, "screen_annotation.closed", trace, closed_attributes]
           ] = result.rows

    assert trace == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert closed_attributes["cause"] == "share_replaced"

    assert Map.keys(opened_attributes) -- ~w(tenantId spaceId episodeId layerId publicationId) ==
             []
  end

  def operation_id(ms) do
    <<entropy::74, _::6>> = :crypto.strong_rand_bytes(10)
    <<a::12, b::62>> = <<entropy::74>>
    UUID.load!(<<ms::48, 7::4, a::12, 2::2, b::62>>)
  end

  def bind_frame(publication),
    do:
      command(nil, nil, %{
        "kind" => "bind",
        "publication_id" => publication,
        "frame" => %{"width" => 1920, "height" => 1080}
      })

  def command(layer, fence, command) do
    %{
      "type" => "annotation_command",
      "layer_id" => layer,
      "fence" => fence,
      "command" => command,
      "operation_id" => operation_id(System.system_time(:millisecond))
    }
  end

  def draft do
    %{
      "mark_id" => UUID.generate(),
      "lifetime" => "keep",
      "color" => "#e55050",
      "width" => 128,
      "shape" => %{"kind" => "stamp", "at" => %{"x" => 1024, "y" => 1024}, "stamp" => "check"}
    }
  end

  defp uuid(value), do: UUID.dump!(value)
end
