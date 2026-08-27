defmodule ChalkSync.WhiteboardV1.Repository do
  @moduledoc "Durable whiteboard-v1 repository boundary."

  alias ChalkSync.Stateholder.Identity

  @type commit :: %{
          operation_id: String.t(),
          outcome: :committed | :duplicate,
          scene_id: String.t(),
          revision: non_neg_integer()
        }

  @callback connect(Identity.t()) :: {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  @callback commit_update(Identity.t(), map()) ::
              {:ok, commit()} | {:error, atom()} | {:retryable, atom()}
  @callback clear(Identity.t(), map()) ::
              {:ok, commit()} | {:error, atom()} | {:retryable, atom()}
  @callback set_draw_permission(Identity.t(), map()) ::
              {:ok, commit()} | {:error, atom()} | {:retryable, atom()}
  @callback set_presentation(Identity.t(), map()) ::
              {:ok, commit()} | {:error, atom()} | {:retryable, atom()}
  @callback snapshot(Identity.t()) :: {:ok, map()} | {:error, atom()} | {:retryable, atom()}
  @callback read_after(Identity.t(), String.t(), non_neg_integer()) ::
              {:ok, [map()]} | {:error, atom()} | {:retryable, atom()}

  def connect(identity), do: impl().connect(identity)
  def commit_update(identity, operation), do: impl().commit_update(identity, operation)
  def clear(identity, operation), do: impl().clear(identity, operation)

  def set_draw_permission(identity, operation),
    do: impl().set_draw_permission(identity, operation)

  def set_presentation(identity, operation), do: impl().set_presentation(identity, operation)

  def snapshot(identity), do: impl().snapshot(identity)

  def read_after(identity, scene_id, revision),
    do: impl().read_after(identity, scene_id, revision)

  defp impl,
    do:
      Application.get_env(
        :chalk_sync,
        :whiteboard_v1_repository,
        ChalkSync.WhiteboardV1.PostgresRepository
      )
end
