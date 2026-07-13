defmodule ChalkSync.Live.DirectedRequestsTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Live.DirectedRequests

  @actor "00000000-0000-4000-8000-000000000001"
  @target "00000000-0000-4000-8000-000000000002"

  test "delivers to active target connections with a stable id and releases on ACK" do
    assert {:ok, state} = DirectedRequests.register(DirectedRequests.new(), @target, self())
    request = request("directed-request-0001")

    assert {state, :delivered} = DirectedRequests.deliver(state, request, 100)

    assert_receive {:directed_request,
                    %{
                      "type" => "directed_request",
                      "request_id" => "directed-request-0001",
                      "name" => "request_unmute",
                      "actor_participant_session_id" => @actor,
                      "expires_at_ms" => 30_100
                    }}

    assert {state, :delivered} = DirectedRequests.deliver(state, request, 101)
    refute_receive {:directed_request, _frame}
    assert {:ok, state} = DirectedRequests.acknowledge(state, @target, request.request_id, 102)
    assert %{pending: 0, recent: 1} = DirectedRequests.stats(state)

    assert {:error, :unknown_request, _state} =
             DirectedRequests.acknowledge(state, @target, request.request_id, 103)
  end

  test "does not replay to a connection registered after the send" do
    request = request("directed-request-0002")

    assert {state, :target_unavailable} =
             DirectedRequests.deliver(DirectedRequests.new(), request, 0)

    assert {:ok, state} = DirectedRequests.register(state, @target, self())
    refute_receive {:directed_request, _frame}
    assert {_, :target_unavailable} = DirectedRequests.deliver(state, request, 1)
  end

  test "rate limits each actor-target pair to four requests per 30 seconds" do
    assert {:ok, state} = DirectedRequests.register(DirectedRequests.new(), @target, self())

    state =
      Enum.reduce(1..4, state, fn index, current ->
        assert {next, :delivered} =
                 DirectedRequests.deliver(current, request("directed-request-000#{index}"), index)

        next
      end)

    assert {state, :rate_limited} =
             DirectedRequests.deliver(state, request("directed-request-0005"), 5)

    assert {_, :delivered} =
             DirectedRequests.deliver(state, request("directed-request-0006"), 30_001)
  end

  test "expires unacknowledged delivery at 30 seconds and rejects wrong-target ACKs" do
    assert {:ok, state} = DirectedRequests.register(DirectedRequests.new(), @target, self())
    request = request("directed-request-0007")
    assert {state, :delivered} = DirectedRequests.deliver(state, request, 200)

    assert {:error, :wrong_target, state} =
             DirectedRequests.acknowledge(state, @actor, request.request_id, 201)

    assert {state, [%{request_id: "directed-request-0007", result: :expired}]} =
             DirectedRequests.expire(state, 30_200)

    assert %{pending: 0, retained_bytes: bytes} = DirectedRequests.stats(state)
    assert bytes <= 1_048_576
  end

  test "rejects conflicting reuse of a request id" do
    first = request("directed-request-0008")

    assert {state, :target_unavailable} =
             DirectedRequests.deliver(DirectedRequests.new(), first, 0)

    conflict = %{first | name: :request_start_camera}
    assert {_, :rejected} = DirectedRequests.deliver(state, conflict, 1)
  end

  defp request(request_id) do
    %{
      request_id: request_id,
      name: :request_unmute,
      actor_participant_session_id: @actor,
      target_participant_session_id: @target
    }
  end
end
