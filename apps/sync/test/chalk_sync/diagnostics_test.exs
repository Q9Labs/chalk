defmodule ChalkSync.DiagnosticsTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Chat
  alias ChalkSync.Diagnostics
  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Diagnostics.Deadlines
  alias ChalkSync.Diagnostics.Exporter
  alias ChalkSync.Diagnostics.ServiceCredential
  alias ChalkSync.Diagnostics.Transport
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  @buffer __MODULE__.Buffer
  @deadlines __MODULE__.Deadlines

  setup do
    previous = Application.get_env(:chalk_sync, :episode_diagnostics)
    on_exit(fn -> Application.put_env(:chalk_sync, :episode_diagnostics, previous) end)
    :ok
  end

  test "the facade always returns ok and rejects non-allowlisted data before buffering" do
    start_buffer()

    assert :ok = Diagnostics.record(:unknown_constructor, episode(), attributes: %{status: :ok})

    assert :ok =
             Diagnostics.record(:chat_send_received, episode(),
               attributes: %{content: "private chat body"}
             )

    assert :ok =
             Diagnostics.record(:chat_send_received, episode(),
               command_id: "customer name / private token"
             )

    assert Buffer.stats(@buffer).events == 0

    GenServer.stop(@buffer)
    assert :ok = Diagnostics.record(:chat_send_received, episode())
  end

  test "the ETS buffer remains count bounded without mailbox-per-event writes" do
    pid = start_buffer(max_events: 2, max_bytes: 16_384)

    for _index <- 1..100 do
      assert :ok = Diagnostics.record(:reaction_send_received, episode())
    end

    stats = Buffer.stats(@buffer)
    assert stats.events <= 2
    assert stats.bytes <= stats.max_bytes
    assert stats.dropped > 0

    {:message_queue_len, queue_length} = Process.info(pid, :message_queue_len)
    assert queue_length <= 1
  end

  test "the ETS buffer never mixes participant scopes in an export batch" do
    start_buffer()
    first = identity()
    second = %{first | participant_id: "00000000-0000-4000-8000-000000000005"}

    assert :ok = Diagnostics.record(:reaction_send_received, first)
    assert :ok = Diagnostics.record(:reaction_send_received, second)

    assert {:ok, %{"participantId" => first_id}, first_entries} =
             Buffer.take_batch(@buffer, 10, 16_384)

    assert first_id == first.participant_id
    assert length(first_entries) == 1
    Buffer.acknowledge(@buffer, Enum.map(first_entries, & &1.event_id))

    assert {:ok, %{"participantId" => second_id}, second_entries} =
             Buffer.take_batch(@buffer, 10, 16_384)

    assert second_id == second.participant_id
    assert length(second_entries) == 1
  end

  test "age eviction emits a content-free coverage gap" do
    start_buffer(max_age_ms: 100)
    assert :ok = Diagnostics.record(:chat_send_received, episode())

    Process.sleep(105)

    eventually(
      fn ->
        assert {:ok, _scope, [%{event: event}]} = Buffer.take_batch(@buffer)
        assert event["name"] == "coverage.gap"

        assert event["attributes"] == %{
                 "count" => 1,
                 "kind" => "gap",
                 "reason" => "buffer_age"
               }

        refute JSON.encode!(event) =~ "private"
      end,
      8
    )
  end

  test "a retry reuses the stable event id and a duplicate response acknowledges it" do
    start_buffer()
    {:ok, counter} = Agent.start_link(fn -> 0 end)
    config = transport_config(%{test_pid: self(), counter: counter})

    assert :ok = Diagnostics.record(:episode_extend_received, episode())

    start_supervised!(
      {Exporter,
       name: __MODULE__.Exporter,
       buffer: @buffer,
       transport: __MODULE__.RetryThenDuplicateTransport,
       config: config,
       interval_ms: 2,
       max_retries: 3}
    )

    assert_receive {:append, [first_id]}, 500
    assert_receive {:append, [second_id]}, 500
    assert first_id == second_id
    eventually(fn -> assert Buffer.stats(@buffer).events == 0 end)
  end

  test "the HTTP transport emits the exact authenticated append envelope" do
    start_buffer()
    assert :ok = Diagnostics.record(:sync_connect_started, episode())
    assert {:ok, scope, [%{event: event}]} = Buffer.take_batch(@buffer)

    listener =
      start_supervised!(
        {Bandit,
         plug: {__MODULE__.IntakePlug, self()}, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)

    task =
      Task.async(fn ->
        Transport.append(
          transport_config(%{
            base_url: "http://127.0.0.1:#{port}",
            connect_timeout_ms: 2_000,
            request_timeout_ms: 2_000
          }),
          scope,
          [event]
        )
      end)

    assert_receive {:intake, request}, 2_000
    assert request.path == "/_internal/episode-diagnostic-events"
    assert request.authorization == "Bearer #{String.duplicate("t", 16)}"

    assert request.body == %{
             "version" => 1,
             "producer" => %{
               "id" => "sync",
               "instanceId" => "sync-test-instance",
               "generation" => 1
             },
             "scope" => scope,
             "events" => [event]
           }

    send(request.handler, {
      :respond,
      200,
      %{
        "diagnosticReference" => "diag_0000000000000001",
        "committedCursor" => 1,
        "accepted" => [%{"eventId" => event["eventId"], "cursor" => 1}],
        "duplicates" => [],
        "conflicts" => []
      }
    })

    assert {:ok, %{accepted: [event_id], duplicates: [], conflicts: []}} = Task.await(task)
    assert event_id == event["eventId"]
  end

  test "transport configuration accepts origins and rejects prefixed paths" do
    assert :ok = Transport.validate_config(transport_config(%{}))

    assert {:error, :invalid_url} =
             Transport.validate_config(
               transport_config(%{base_url: "http://127.0.0.1:4101/prefix"})
             )

    assert {:error, :invalid_url} =
             Transport.validate_config(
               transport_config(%{
                 mode: :hosted,
                 base_url: "https://api.example.test/prefix",
                 allowed_hosts: ["api.example.test"]
               })
             )

    assert {:error, :invalid_url} =
             Transport.validate_config(
               transport_config(%{
                 base_url: "http://127.0.0.1:4101",
                 allowed_hosts: ["sync.example.test"]
               })
             )
  end

  test "transport rejects private hosted destinations and permits loopback only locally" do
    assert {:error, :destination_blocked} =
             Transport.validate_resolved_addresses([{127, 0, 0, 1}], :hosted)

    assert {:error, :destination_blocked} =
             Transport.validate_resolved_addresses([{10, 0, 0, 1}], :hosted)

    assert {:error, :destination_blocked} =
             Transport.validate_resolved_addresses([{0xFE80, 0, 0, 0, 0, 0, 0, 1}], :hosted)

    assert :ok = Transport.validate_resolved_addresses([{127, 0, 0, 1}], :localhost)
  end

  test "transport does not follow redirects with the producer bearer" do
    start_buffer()
    assert :ok = Diagnostics.record(:sync_connect_started, episode())
    assert {:ok, scope, [%{event: event}]} = Buffer.take_batch(@buffer)

    listener =
      start_supervised!(
        {Bandit,
         plug: {__MODULE__.RedirectPlug, self()}, ip: {127, 0, 0, 1}, port: 0, startup_log: false}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(listener)

    result =
      Transport.append(
        transport_config(%{
          base_url: "http://127.0.0.1:#{port}",
          connect_timeout_ms: 2_000,
          request_timeout_ms: 2_000
        }),
        scope,
        [event]
      )

    assert {:retryable, :server_unavailable} = result
    assert_receive {:redirect_hit, "/_internal/episode-diagnostic-events"}
    refute_receive {:redirect_hit, "/final"}, 100
  end

  test "hosted transport mints bound service credentials and rejects static authentication" do
    {public_key, private_seed} = :crypto.generate_key(:eddsa, :ed25519)

    assert {:ok, credential} =
             ServiceCredential.new(
               issuer: "https://identity.example.test",
               key_id: "sync-diagnostics-1",
               private_key: private_seed <> public_key,
               environment: "development",
               instance_id: "sync-hosted-instance",
               generation: 4,
               clock: fn -> 1_775_212_800 end
             )

    hosted =
      transport_config(%{
        mode: :hosted,
        base_url: "https://api.example.test",
        token: nil,
        credential: credential,
        allowed_hosts: ["api.example.test"],
        instance_id: "sync-hosted-instance",
        generation: 4
      })

    assert :ok = Transport.validate_config(hosted)
    assert {:ok, token} = Transport.authorization(hosted)
    assert [_header, encoded_claims, _signature] = String.split(token, ".")
    assert {:ok, claims_json} = Base.url_decode64(encoded_claims, padding: false)

    assert %{
             "source" => "sync",
             "sub" => "sync",
             "instance_id" => "sync-hosted-instance",
             "generation" => 4
           } = JSON.decode!(claims_json)

    assert {:error, :invalid_config} =
             hosted
             |> Map.put(:token, String.duplicate("t", 32))
             |> Transport.validate_config()

    assert {:error, :invalid_config} =
             hosted
             |> Map.put(:instance_id, "different-instance")
             |> Transport.validate_config()

    assert {:error, :invalid_config} =
             transport_config(%{credential: credential}) |> Transport.validate_config()
  end

  test "application unknown is emitted only after its bounded observation deadline" do
    start_buffer()

    start_supervised!(
      {Deadlines, name: @deadlines, sweep_interval_ms: 5, max_entries: 4, sweep_limit: 4}
    )

    assert :ok =
             Deadlines.track(
               @deadlines,
               episode(),
               :chat_application_unknown,
               30,
               operation_ref: "chat-deadline-0001",
               command_id: "chat-deadline-0001",
               attributes: %{reason: :not_observable}
             )

    assert :empty = Buffer.take_batch(@buffer)

    eventually(fn ->
      assert {:ok, _scope, [%{event: event}]} = Buffer.take_batch(@buffer)
      assert event["name"] == "chat.send"
      assert event["state"] == "not_observable"
      assert event["expectation"]["checkpoint"] == "recipient_projection"
      assert is_binary(event["expectation"]["deadlineAt"])
    end)
  end

  test "release, attempt, retry-group, and provider correlations stay safe and closed" do
    start_buffer()
    provider_value = "opaque-provider-row-42"
    key = String.duplicate("k", 32)
    assert {:ok, provider_id} = Diagnostics.provider_hmac(provider_value, key)

    assert :ok =
             Diagnostics.record(:cleanup_fan_in_succeeded, episode(),
               operation_ref: "cleanup-operation-0001",
               retry_group_ref: "cleanup-retry-group-0001",
               provider_id: provider_id,
               attempt: 3,
               release: %{id: "sync-2026.08.04", source_commit: "abc123def456"},
               attributes: %{count: 2, result: :confirmed}
             )

    assert {:ok, _scope, [%{event: event}]} = Buffer.take_batch(@buffer)

    assert event["correlation"] == %{
             "attempt" => 3,
             "providerId" => provider_id,
             "retryGroupRef" => "cleanup-retry-group-0001"
           }

    assert event["release"] == %{
             "id" => "sync-2026.08.04",
             "sourceCommit" => "abc123def456"
           }

    refute JSON.encode!(event) =~ provider_value
    assert event["expectation"]["checkpoint"] == "fan_in_terminal"
  end

  test "chat retries and observable attachment commit boundaries never retain content or ids" do
    start_buffer()

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(
               identity(),
               %{
                 client_message_id: "chat-retry-message-0001",
                 text: "private chat body",
                 attachment_ids: ["00000000-0000-4000-8000-000000000099"]
               },
               repository: __MODULE__.DuplicateChatRepository
             )

    assert {:ok, _scope, events} = Buffer.take_batch(@buffer)
    drafts = Enum.map(events, & &1.event)

    assert Enum.map(drafts, &{&1["name"], &1["expectation"]["checkpoint"]}) == [
             {"chat.retry", "retry_link"}
           ]

    encoded = JSON.encode!(drafts)
    refute encoded =~ "private chat body"
    refute encoded =~ "00000000-0000-4000-8000-000000000099"
  end

  test "attachment diagnostics reflect attempted storage ordering for committed and failed messages" do
    start_buffer()
    attachment_id = "00000000-0000-4000-8000-000000000099"

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(
               identity(),
               %{
                 client_message_id: "chat-attachment-commit-0001",
                 text: "private chat body",
                 attachment_ids: [attachment_id]
               },
               repository: __MODULE__.AttachmentCommittedChatRepository
             )

    assert {:ok, _scope, committed_events} = Buffer.take_batch(@buffer)

    assert Enum.map(committed_events, & &1.event)
           |> Enum.map(&{&1["name"], &1["expectation"]["checkpoint"]}) == [
             {"chat.attachment.commit", "storage_commit"},
             {"chat.send", "durable_commit"},
             {"chat.attachment.commit", "storage_commit"}
           ]

    Buffer.acknowledge(@buffer, Enum.map(committed_events, & &1.event_id))

    assert {:ok, %{"outcome" => "rejected", "error_code" => "attachment_not_ready"}} =
             Chat.send_chat(
               identity(),
               %{
                 client_message_id: "chat-attachment-failed-0001",
                 text: "private chat body",
                 attachment_ids: [attachment_id]
               },
               repository: __MODULE__.AttachmentFailedChatRepository
             )

    assert {:ok, _scope, failed_events} = Buffer.take_batch(@buffer)

    assert Enum.map(failed_events, & &1.event)
           |> Enum.map(&{&1["name"], &1["expectation"]["checkpoint"]}) == [
             {"chat.attachment.commit", "storage_commit"},
             {"chat.send", "authorization"},
             {"chat.attachment.fail", "failure"}
           ]
  end

  test "chat diagnostics preserve journey and W3C trace correlation" do
    start_buffer()

    observability =
      Observability.context(%{
        "journey_id" => "00000000-0000-4000-8000-000000000042",
        "traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
      })

    assert {:ok, %{"outcome" => "accepted"}} =
             Chat.send_chat(
               identity(),
               %{client_message_id: "chat-context-message-0001", text: "private chat body"},
               repository: __MODULE__.CommittedChatRepository,
               observability: observability
             )

    assert {:ok, _scope, [%{event: event}]} = Buffer.take_batch(@buffer)

    assert event["correlation"] == %{
             "commandId" => "chat-context-message-0001",
             "journeyId" => "00000000-0000-4000-8000-000000000042",
             "traceId" => "4bf92f3577b34da6a3ce929d0e0e4736",
             "spanId" => "00f067aa0ba902b7"
           }
  end

  test "malformed attachment ids preserve invalid-payload behavior without diagnostics crashes" do
    start_buffer()

    assert {:ok, %{"outcome" => "rejected", "error_code" => "invalid_payload"}} =
             Chat.send_chat(
               identity(),
               %{
                 client_message_id: "chat-invalid-attachment-0001",
                 text: "private chat body",
                 attachment_ids: "not-a-list"
               },
               repository: __MODULE__.InvalidPayloadChatRepository
             )

    assert {:ok, _scope, [%{event: event}]} = Buffer.take_batch(@buffer)
    assert event["name"] == "chat.send"
    assert event["attributes"]["reason"] == "invalid_contract"
  end

  defmodule DuplicateChatRepository do
    def append(_identity, %{client_message_id: client_message_id}) do
      {:ok,
       %{
         outcome: :duplicate,
         message: %{
           message_id: "00000000-0000-4000-8000-000000000090",
           client_message_id: client_message_id,
           sequence: "42",
           participant_id: "00000000-0000-4000-8000-000000000004",
           display_name: "private display name",
           text: "private chat body",
           attachments: [],
           created_at: "2026-08-04T12:00:00.000Z"
         }
       }}
    end
  end

  defmodule CommittedChatRepository do
    def head(_episode), do: {:ok, %{retained_floor_sequence: "1"}}

    def append(_identity, %{client_message_id: client_message_id}) do
      {:ok,
       %{
         outcome: :committed,
         message: %{
           message_id: "00000000-0000-4000-8000-000000000091",
           client_message_id: client_message_id,
           sequence: "42",
           participant_id: "00000000-0000-4000-8000-000000000004",
           display_name: "private display name",
           text: "private chat body",
           attachments: [],
           created_at: "2026-08-04T12:00:00.000Z"
         }
       }}
    end
  end

  defmodule AttachmentCommittedChatRepository do
    def head(_episode), do: {:ok, %{retained_floor_sequence: "1"}}

    def append(
          _identity,
          %{client_message_id: client_message_id, attachment_commit_observer: observer}
        ) do
      observer.()

      {:ok,
       %{
         outcome: :committed,
         message: %{
           message_id: "00000000-0000-4000-8000-000000000092",
           client_message_id: client_message_id,
           sequence: "42",
           participant_id: "00000000-0000-4000-8000-000000000004",
           display_name: "private display name",
           text: "private chat body",
           attachments: [],
           created_at: "2026-08-04T12:00:00.000Z"
         }
       }}
    end
  end

  defmodule AttachmentFailedChatRepository do
    def append(
          _identity,
          %{attachment_commit_observer: observer}
        ) do
      observer.()
      {:error, :attachment_not_ready}
    end
  end

  defmodule InvalidPayloadChatRepository do
    def append(_identity, _input), do: {:error, :invalid_payload}
  end

  defmodule RetryThenDuplicateTransport do
    def append(config, _scope, events) do
      ids = Enum.map(events, & &1["eventId"])
      send(config.test_pid, {:append, ids})

      case Agent.get_and_update(config.counter, fn count -> {count, count + 1} end) do
        0 ->
          {:retryable, :server_unavailable}

        _attempt ->
          {:ok, %{accepted: [], duplicates: ids, conflicts: []}}
      end
    end
  end

  defmodule IntakePlug do
    import Plug.Conn

    def init(test), do: test

    def call(connection, test) do
      {:ok, body, connection} = read_body(connection, length: 512 * 1_024)

      send(test, {
        :intake,
        %{
          handler: self(),
          path: connection.request_path,
          authorization: get_req_header(connection, "authorization") |> List.first(),
          body: JSON.decode!(body)
        }
      })

      receive do
        {:respond, status, response} ->
          connection
          |> put_resp_content_type("application/json")
          |> send_resp(status, JSON.encode!(response))
      after
        500 -> send_resp(connection, 500, "{}")
      end
    end
  end

  defmodule RedirectPlug do
    import Plug.Conn

    def init(options), do: options

    def call(connection, test) do
      send(test, {:redirect_hit, connection.request_path})

      connection
      |> put_resp_header("location", "/final")
      |> send_resp(302, "")
    end
  end

  defp start_buffer(options \\ []) do
    {:ok, pid} = Buffer.start_link(Keyword.merge([name: @buffer], options))

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    Application.put_env(:chalk_sync, :episode_diagnostics, %{mode: :localhost, buffer: @buffer})
    pid
  end

  defp transport_config(extra) do
    Map.merge(
      %{
        mode: :localhost,
        base_url: "http://127.0.0.1:4101",
        token: String.duplicate("t", 16),
        instance_id: "sync-test-instance",
        generation: 1,
        connect_timeout_ms: 50,
        request_timeout_ms: 50,
        max_request_bytes: 512 * 1_024,
        allowed_hosts: ["127.0.0.1"]
      },
      extra
    )
  end

  defp episode do
    %EpisodeKey{
      tenant_id: "00000000-0000-4000-8000-000000000001",
      space_id: "00000000-0000-4000-8000-000000000002",
      episode_id: "00000000-0000-4000-8000-000000000003"
    }
  end

  defp identity do
    %Identity{
      episode: episode(),
      participant_id: "00000000-0000-4000-8000-000000000004",
      participant_generation: 1
    }
  end

  defp eventually(assertion, attempts \\ 50)

  defp eventually(assertion, attempts) when attempts > 0 do
    assertion.()
  rescue
    ExUnit.AssertionError ->
      Process.sleep(5)
      eventually(assertion, attempts - 1)
  end

  defp eventually(assertion, 0), do: assertion.()
end
