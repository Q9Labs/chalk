defmodule ChalkSync.Chat.Pagination do
  @moduledoc """
  Reads one page of retained chat history for a socket.
  """

  alias ChalkSync.Chat.Collaborators
  alias ChalkSync.Chat.Input
  alias ChalkSync.Chat.Repository.Message
  alias ChalkSync.Stateholder.Identity

  @spec read_chat_page(Identity.t(), map()) :: {:ok, map()} | {:error, atom()}
  def read_chat_page(%Identity{} = identity, input) do
    read_chat_page(identity, input, [])
  end

  @spec read_chat_page(Identity.t(), map(), keyword()) :: {:ok, map()} | {:error, atom()}
  def read_chat_page(
        %Identity{} = identity,
        %{request_id: request_id, direction: direction, cursor_sequence: cursor, limit: limit},
        options
      )
      when is_binary(request_id) and is_integer(limit) and is_list(options) do
    repository = Collaborators.repository(options)

    with :ok <- Input.validate_operation_id(request_id),
         {:ok, _profile} <- repository.authorize(identity, nil) do
      request = %{
        direction: Input.normalize_direction(direction),
        cursor_sequence: cursor,
        limit: limit
      }

      case repository.read_page(identity.episode, request) do
        {:ok, page} -> {:ok, loaded_page(request_id, page, options)}
        {:cursor_reset, floor} -> {:ok, cursor_reset_page(request_id, floor)}
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
    end
  end

  def read_chat_page(%Identity{}, _input, _options) do
    {:error, :invalid_payload}
  end


  defp loaded_page(request_id, page, options) do
    %{
      "type" => "chat_page",
      "request_id" => request_id,
      "outcome" => "loaded",
      "messages" => Enum.map(page.messages, &Message.wire(&1, Keyword.get(options, :version, 2))),
      "has_more" => page.has_more,
      "head_sequence" => page.head_sequence,
      "retained_floor_sequence" => page.retained_floor_sequence
    }
  end


  defp cursor_reset_page(request_id, floor) do
    %{
      "type" => "chat_page",
      "request_id" => request_id,
      "outcome" => "cursor_reset",
      "retained_floor_sequence" => floor
    }
  end
end
