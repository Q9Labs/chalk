defmodule ChalkSync.ScreenAnnotation.Proof do
  @moduledoc false
  import ExUnit.Assertions

  def cleanup_journey(connection, episode) do
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
end
