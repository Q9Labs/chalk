defmodule ChalkSync.ScreenAnnotation.Layer do
  @moduledoc "Pure transitions for an authenticated, publication-bound annotation layer."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema

  @limits Schema.limits()
  @colors ~w(#e55050 #2382dd #26965d #a655da #bc7324 #079395 #d74286 #6c6ecb)

  def contributor(id, name) do
    %{
      "participant_id" => id,
      "display_name" => bounded_name(name),
      "color" => Enum.at(@colors, :erlang.phash2(id, length(@colors)))
    }
  end

  defp bounded_name(name) when is_binary(name) and byte_size(name) in 1..256, do: name
  defp bounded_name(_name), do: "Participant"

  def prune(layer, now) do
    %{
      layer
      | marks: Map.reject(layer.marks, fn {_id, mark} -> expired?(mark, now) end),
        requests: Map.reject(layer.requests, fn {_id, request} -> expired?(request, now) end)
    }
  end

  defp expired?(%{"expires_at_ms" => expiry}, now), do: is_integer(expiry) and expiry <= now

  def access(layer, actor) do
    %{
      "draw_policy" => actor.draw_policy,
      "default_color" => actor.author["color"],
      "can_draw" => can_draw?(layer, actor),
      "can_moderate" => moderator?(layer, actor),
      "can_manage_policy" => actor.manager,
      "requests" =>
        for({id, request} <- layer.requests, id == actor.id or actor.manager, do: request)
    }
  end

  def snapshot(layer, actor) do
    %{
      "layer" => layer.binding,
      "revision" => layer.revision,
      "fence" => layer.fence,
      "paused" => layer.paused,
      "access" => access(layer, actor),
      "marks" => Enum.sort_by(Map.values(layer.marks), & &1["created_revision"])
    }
  end

  def apply(layer, %{"kind" => "commit", "draft" => draft}, actor, now) do
    with :ok <- require_draw(layer, actor) do
      id = draft["mark_id"]

      cond do
        Map.has_key?(layer.marks, id) ->
          {:error, "invalid_target"}

        map_size(layer.marks) >= @limits["activeMarks"] ->
          {:error, "capacity"}

        true ->
          mark = %{
            "draft" => draft,
            "author" => actor.author,
            "created_revision" => layer.revision + 1,
            "committed_at_ms" => now,
            "expires_at_ms" =>
              if(draft["lifetime"] == "fade", do: now + @limits["committedFadeTtlMs"])
          }

          next = put_in(layer.marks[id], mark)

          next =
            if draft["lifetime"] == "keep",
              do: remember(next, actor.id, "upsert", mark),
              else: drop_redo(next, actor.id)

          change(next, %{"kind" => "upsert", "mark" => mark})
      end
    end
  end

  def apply(layer, %{"kind" => "erase", "mark_id" => id}, actor, _now) do
    case Map.fetch(layer.marks, id) do
      :error -> {:ok, layer}
      {:ok, mark} -> erase(layer, actor, id, mark)
    end
  end

  def apply(layer, %{"kind" => key}, actor, _now) when key in ["undo", "redo"] do
    with :ok <- require_draw(layer, actor) do
      undo_or_redo(layer, actor.id, key)
    end
  end

  def apply(layer, %{"kind" => "clear", "scope" => scope}, actor, _now) do
    if scope["kind"] == "mine" or moderator?(layer, actor) do
      id = if scope["kind"] == "mine", do: actor.id, else: scope["participant_id"]
      matches = fn mark -> is_nil(id) or mark["author"]["participant_id"] == id end
      next = %{layer | marks: Map.reject(layer.marks, fn {_id, mark} -> matches.(mark) end)}
      next = purge_history(next, matches)
      fence(next, %{"kind" => "clear", "participant_id" => id})
    else
      {:error, "forbidden"}
    end
  end

  def apply(layer, %{"kind" => "pause", "paused" => paused}, actor, _now) do
    cond do
      not moderator?(layer, actor) -> {:error, "forbidden"}
      paused == layer.paused -> {:ok, layer}
      true -> fence(%{layer | paused: paused}, %{"kind" => "control", "paused" => paused})
    end
  end

  def apply(layer, %{"kind" => "request_draw"}, actor, now) do
    cond do
      actor.can_draw or actor.draw_policy == "hosts" or
          (actor.draw_policy == "everyone" and actor.explicit_grant != false) ->
        {:error, "forbidden"}

      Map.has_key?(layer.requests, actor.id) ->
        {:ok, layer}

      map_size(layer.requests) >= @limits["pendingDrawRequests"] ->
        {:error, "capacity"}

      true ->
        request = %{
          "request_id" => actor.operation_id,
          "participant_id" => actor.id,
          "expires_at_ms" => now + @limits["drawRequestTtlMs"]
        }

        change(put_in(layer.requests[actor.id], request), nil)
    end
  end

  def apply(
        layer,
        %{"kind" => "decide_draw", "request_id" => request_id, "allow" => allow},
        actor,
        _now
      ) do
    with true <- actor.manager,
         {id, _request} <-
           Enum.find(layer.requests, fn {_id, request} -> request["request_id"] == request_id end) do
      if allow do
        {:grant, id, true}
      else
        change(%{layer | requests: Map.delete(layer.requests, id)}, nil)
      end
    else
      false -> {:error, "forbidden"}
      nil -> {:error, "invalid_target"}
    end
  end

  def apply(
        _layer,
        %{"kind" => "set_draw_permission", "participant_id" => id, "allow" => allow},
        actor,
        _now
      ) do
    if actor.manager, do: {:grant, id, allow}, else: {:error, "forbidden"}
  end

  def apply(_layer, %{"kind" => "set_policy", "policy" => policy}, actor, _now) do
    if actor.manager, do: {:policy, policy}, else: {:error, "forbidden"}
  end

  defp erase(layer, actor, id, mark) do
    own = actor.id == mark["author"]["participant_id"]

    cond do
      own and can_draw?(layer, actor) ->
        next = %{layer | marks: Map.delete(layer.marks, id)}

        next =
          if mark["expires_at_ms"],
            do: drop_redo(next, actor.id),
            else: remember(next, actor.id, "remove", mark)

        change(next, %{"kind" => "remove", "mark_id" => id})

      moderator?(layer, actor) ->
        next = %{layer | marks: Map.delete(layer.marks, id)}
        next = purge_history(next, &(&1["draft"]["mark_id"] == id))
        fence(next, %{"kind" => "remove", "mark_id" => id})

      true ->
        require_draw(layer, actor, false)
    end
  end

  defp undo_or_redo(layer, id, key) do
    case Map.get(history(layer, id), key) do
      [] ->
        {:ok, layer}

      [%{"kind" => kind, "mark" => mark} = action | remaining] ->
        other = if key == "undo", do: "redo", else: "undo"
        upsert? = (key == "redo" and kind == "upsert") or (key == "undo" and kind == "remove")
        mark_id = mark["draft"]["mark_id"]

        if upsert? and map_size(layer.marks) >= @limits["activeMarks"] do
          {:error, "capacity"}
        else
          history =
            history(layer, id) |> Map.put(key, remaining) |> Map.update!(other, &[action | &1])

          next = put_in(layer.history[id], history)

          if upsert? do
            change(put_in(next.marks[mark_id], mark), %{"kind" => "upsert", "mark" => mark})
          else
            change(%{next | marks: Map.delete(next.marks, mark_id)}, %{
              "kind" => "remove",
              "mark_id" => mark_id
            })
          end
        end
    end
  end

  defp remember(layer, id, kind, mark) do
    action = %{"kind" => kind, "mark" => mark}
    undo = Enum.take([action | history(layer, id)["undo"]], @limits["retainedUndoPerPerson"])
    put_in(layer.history[id], %{"undo" => undo, "redo" => []})
  end

  defp drop_redo(layer, id) do
    case Map.fetch(layer.history, id) do
      {:ok, history} -> put_in(layer.history[id], %{history | "redo" => []})
      :error -> layer
    end
  end

  defp purge_history(layer, matches) do
    history =
      Map.new(layer.history, fn {id, history} ->
        {id,
         Map.new(history, fn {key, actions} ->
           {key, Enum.reject(actions, &matches.(&1["mark"]))}
         end)}
      end)
      |> Map.reject(fn {_id, history} -> history["undo"] == [] and history["redo"] == [] end)

    %{layer | history: history}
  end

  defp history(layer, id), do: Map.get(layer.history, id, %{"undo" => [], "redo" => []})

  defp change(layer, change),
    do: {:ok, %{layer | revision: layer.revision + 1, last_change: change}}

  defp fence(layer, change), do: change(%{layer | fence: layer.fence + 1}, change)

  defp moderator?(layer, actor), do: actor.manager or sharer?(layer, actor)
  defp sharer?(layer, actor), do: layer.binding["sharer_id"] == actor.id
  defp can_draw?(layer, actor), do: actor.can_draw and (not layer.paused or sharer?(layer, actor))

  defp require_draw(layer, actor, allowed \\ true) do
    cond do
      not actor.can_draw or not allowed -> {:error, "forbidden"}
      not can_draw?(layer, actor) -> {:error, "paused"}
      true -> :ok
    end
  end
end
