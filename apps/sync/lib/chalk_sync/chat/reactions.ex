defmodule ChalkSync.Chat.Repository.Reactions do
  @moduledoc false

  alias ChalkSync.UUID

  @max_memberships 128

  def set(connection, identity, %{message_id: message_id, emoji: emoji, on: on}) do
    episode = identity.episode
    params = [UUID.dump!(episode.tenant_id), UUID.dump!(episode.space_id), UUID.dump!(message_id)]

    case Postgrex.query!(
           connection,
           "select reaction_revision from sync_chat_messages where tenant_id = $1 and space_id = $2 and message_id = $3 and episode_id = $4 for update",
           params ++ [UUID.dump!(episode.episode_id)]
         ).rows do
      [[_revision]] ->
        change(connection, params, UUID.dump!(identity.participant_id), emoji, on)
        snapshot(connection, params, message_id)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_payload})
    end
  end

  def attach(connection, [tenant_id, space_id, _episode_id], messages) do
    params = [tenant_id, space_id, Enum.map(messages, &UUID.dump!(&1.message_id))]

    states =
      Postgrex.query!(
        connection,
        """
        select message.message_id, message.reaction_revision, coalesce(jsonb_agg(jsonb_build_object('emoji', reaction.emoji, 'participant_id', reaction.participant_id) order by reaction.emoji, reaction.participant_id) filter (where reaction.emoji is not null), '[]'::jsonb)
        from sync_chat_messages message
        left join sync_chat_message_reactions reaction using (tenant_id, space_id, message_id)
        where message.tenant_id = $1 and message.space_id = $2 and message.message_id = any($3::uuid[])
        group by message.tenant_id, message.space_id, message.sequence
        """,
        params
      ).rows
      |> Map.new(fn [id, revision, rows] ->
        {UUID.load!(id), {Integer.to_string(revision), groups(rows)}}
      end)

    Enum.map(messages, fn message ->
      {revision, reactions} = Map.fetch!(states, message.message_id)
      Map.merge(message, %{reaction_revision: revision, reactions: reactions})
    end)
  end

  defp change(connection, params, participant, emoji, true) do
    rows =
      Postgrex.query!(
        connection,
        "select participant_id, emoji from sync_chat_message_reactions where tenant_id = $1 and space_id = $2 and message_id = $3",
        params
      ).rows

    exists = Enum.any?(rows, fn [id, value] -> id == participant and value == emoji end)

    if not exists and length(rows) >= @max_memberships,
      do: Postgrex.rollback(connection, {:error, :overloaded})

    result =
      Postgrex.query!(
        connection,
        "insert into sync_chat_message_reactions (tenant_id, space_id, message_id, participant_id, emoji) values ($1, $2, $3, $4, $5) on conflict do nothing",
        params ++ [participant, emoji]
      )

    advance(connection, params, result.num_rows)
  end

  defp change(connection, params, participant, emoji, false) do
    result =
      Postgrex.query!(
        connection,
        "delete from sync_chat_message_reactions where tenant_id = $1 and space_id = $2 and message_id = $3 and participant_id = $4 and emoji = $5",
        params ++ [participant, emoji]
      )

    advance(connection, params, result.num_rows)
  end

  defp advance(_connection, _params, 0), do: :ok

  defp advance(connection, params, _count) do
    Postgrex.query!(
      connection,
      "update sync_chat_messages set reaction_revision = reaction_revision + 1 where tenant_id = $1 and space_id = $2 and message_id = $3",
      params
    )

    :ok
  end

  defp snapshot(connection, params, message_id) do
    [[revision]] =
      Postgrex.query!(
        connection,
        "select reaction_revision from sync_chat_messages where tenant_id = $1 and space_id = $2 and message_id = $3",
        params
      ).rows

    rows =
      Postgrex.query!(
        connection,
        "select emoji, participant_id from sync_chat_message_reactions where tenant_id = $1 and space_id = $2 and message_id = $3 order by emoji, participant_id",
        params
      ).rows

    reactions =
      Enum.map(rows, fn [emoji, id] -> %{"emoji" => emoji, "participant_id" => UUID.load!(id)} end)

    %{
      "type" => "chat_reactions",
      "message_id" => message_id,
      "revision" => Integer.to_string(revision),
      "reactions" => groups(reactions)
    }
  end

  defp groups(rows) do
    rows
    |> Enum.group_by(& &1["emoji"], & &1["participant_id"])
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(fn {emoji, ids} -> %{"emoji" => emoji, "participant_ids" => Enum.sort(ids)} end)
  end
end
