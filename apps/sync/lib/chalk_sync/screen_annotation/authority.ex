defmodule ChalkSync.ScreenAnnotation.Authority do
  @moduledoc "Reconstructs the live draw and publication witness from Postgres."

  alias ChalkSync.ScreenAnnotation.{Layer, SQL}
  alias ChalkSync.WhiteboardV1.PostgresRepository.Store

  def read(connection, identity) do
    params =
      Store.context(identity) ++
        [Store.uuid(identity.participant_id), identity.participant_generation]

    case Postgrex.query(connection, SQL.read(), params, log: nil) do
      {:ok, %{rows: [row]}} -> decode(row, identity)
      {:ok, %{rows: []}} -> {:error, "not_active"}
      {:error, _reason} -> {:retryable, :storage_unavailable}
    end
  end

  defp decode([name, capabilities, draw?, policy, explicit | row], identity) do
    [owner, generation, until, publication | row] = row

    [
      id,
      bound_publication,
      sharer,
      bound_generation,
      frame,
      revision,
      fence,
      paused,
      marks,
      requests,
      history,
      last_change,
      now
    ] = row

    actor = %{
      id: identity.participant_id,
      generation: identity.participant_generation,
      author: Layer.contributor(identity.participant_id, name),
      manager: "manageWhiteboard" in capabilities,
      can_draw: draw?,
      draw_policy: policy,
      explicit_grant: explicit
    }

    share =
      if is_binary(publication) and is_binary(owner) and
           generation_matches?(publication, generation) do
        %{owner: owner, generation: generation, publication: publication, until: until}
      end

    layer =
      if id do
        %{
          binding: %{
            "layer_id" => id,
            "publication_id" => bound_publication,
            "sharer_id" => sharer,
            "frame" => frame
          },
          generation: bound_generation,
          revision: revision,
          fence: fence,
          paused: paused,
          marks: marks,
          requests: requests,
          history: history,
          last_change: last_change
        }
      end

    {:ok, actor, share, layer, now}
  end

  # The provider's v1 publication reference is the generation witness. A legacy
  # reference may still be played, but cannot prove ownership for annotation.
  defp generation_matches?("chalk_pub_v1." <> encoded, generation) do
    with {:ok, payload} <- Base.url_decode64(encoded, padding: false),
         {:ok, %{"g" => ^generation, "c" => connection, "t" => track, "m" => mid}} <-
           JSON.decode(payload) do
      Enum.all?([connection, track, mid], &(is_binary(&1) and &1 != ""))
    else
      _ -> false
    end
  end

  defp generation_matches?(_publication, _generation), do: false

  def valid_layer(
        %{
          binding: %{"publication_id" => publication, "sharer_id" => owner},
          generation: generation
        } = layer,
        %{publication: publication, owner: owner, generation: generation},
        now
      ),
      do: Layer.prune(layer, now)

  def valid_layer(_layer, _share, _now), do: nil
end
