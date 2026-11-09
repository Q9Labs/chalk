defmodule ChalkSync.Transport.SocketChatTelemetryTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Transport.SocketV1

  defmodule RateLimitedChat do
    def append(_identity, _input), do: {:error, :rate_limited}
  end

  setup do
    previous = Application.get_env(:chalk_sync, :chat_repository)
    Application.put_env(:chalk_sync, :chat_repository, RateLimitedChat)
    owner = self()
    handler = "chat-telemetry-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:chalk_sync, :observability, :event],
      fn _event, _measurements, metadata, _config ->
        if metadata.event == "sync.collaboration",
          do: send(owner, {:collaboration, metadata.attributes})
      end,
      nil
    )

    on_exit(fn ->
      :telemetry.detach(handler)

      if previous,
        do: Application.put_env(:chalk_sync, :chat_repository, previous),
        else: Application.delete_env(:chalk_sync, :chat_repository)
    end)
  end

  test "a refused chat send records the refusal reason, not only that it was rejected" do
    {:ok, state} = SocketV1.init(%{})
    Process.cancel_timer(state.hello_timer)

    state = %{
      state
      | phase: :live,
        identity: identity(),
        collaboration_negotiated: true,
        collaboration_version: 2
    }

    frame =
      Jason.encode!(%{
        "type" => "chat_send",
        "client_message_id" => "telemetry-message-0000000001",
        "text" => "Hello",
        "attachment_ids" => []
      })

    assert {:push, {:text, pushed}, _state} = SocketV1.handle_in({frame, [opcode: :text]}, state)
    assert %{"outcome" => "rejected", "error_code" => "rate_limited"} = Jason.decode!(pushed)
    assert_receive {:collaboration, %{operation: "chat.send", outcome: "rate_limited"}}
  end

  defp identity do
    %Identity{
      episode: %EpisodeKey{
        tenant_id: "00000000-0000-4000-8000-000000000011",
        space_id: "00000000-0000-4000-8000-000000000012",
        episode_id: "00000000-0000-4000-8000-000000000013"
      },
      participant_id: "00000000-0000-4000-8000-000000000014",
      participant_generation: 1
    }
  end
end
