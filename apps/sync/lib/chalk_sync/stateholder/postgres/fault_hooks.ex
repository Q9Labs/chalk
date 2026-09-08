defmodule ChalkSync.Stateholder.Postgres.FaultHooks do
  @moduledoc false

  def command(point, identity, command) do
    case Application.get_env(:chalk_sync, :stateholder_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: identity.episode.tenant_id,
          episode_id: identity.episode.episode_id,
          command_id: command.id
        })

      _ ->
        :ok
    end
  end

  def lifecycle(point, episode, lifecycle_intent_id) do
    case Application.get_env(:chalk_sync, :lifecycle_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: episode.tenant_id,
          episode_id: episode.episode_id,
          lifecycle_intent_id: lifecycle_intent_id
        })

      _ ->
        :ok
    end
  end

  def external_operation(point, episode, external) do
    case Application.get_env(:chalk_sync, :external_operation_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: episode.tenant_id,
          episode_id: episode.episode_id,
          external_operation_id: Map.get(external, :external_operation_id),
          request_key: Map.get(external, :request_key),
          operation: external.name
        })

      _ ->
        :ok
    end
  end
end
