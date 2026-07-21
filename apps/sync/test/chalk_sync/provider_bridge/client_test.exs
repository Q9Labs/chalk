defmodule ChalkSync.ProviderBridge.ClientTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ProviderBridge.Client
  alias ChalkSync.ProviderBridge.MediaPlane
  alias ChalkSync.ProviderBridge.RecordingPlane
  alias ChalkSync.Stateholder.SessionKey

  @tenant "00000000-0000-4000-8000-000000000001"
  @room "00000000-0000-4000-8000-000000000002"
  @session_id "00000000-0000-4000-8000-000000000003"
  @session %SessionKey{tenant_id: @tenant, room_id: @room, session_id: @session_id}
  @participant "00000000-0000-4000-8000-000000000004"
  @recording "00000000-0000-4000-8000-000000000005"

  test "readiness requires the exact private response contract" do
    for {body, expected} <- [
          {JSON.encode!(%{"status" => "ready"}), :ok},
          {JSON.encode!(%{"status" => "ok"}),
           {:error, {:retryable_failure, :malformed_response}}},
          {JSON.encode!(%{"status" => "ready", "detail" => "extra"}),
           {:error, {:retryable_failure, :malformed_response}}}
        ] do
      transport = fn :get, url, _headers, <<>>, _options ->
        send(self(), {:readiness_request, url})
        {:ok, 200, [], body}
      end

      client = Client.new!(base_url: "http://localhost:4101", transport: transport)
      assert Client.ready(client) == expected

      assert_receive {:readiness_request,
                      "http://localhost:4101/internal/v1/sync/provider-bridge/ready"}
    end
  end

  test "media callbacks send exact private paths, bodies, and context headers" do
    transport = fn method, url, headers, body, options ->
      send(self(), {:request, method, url, headers, body, options})

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => "operation-0000001",
         "effect" => "media.grant_publication",
         "outcome" => "confirmed"
       })}
    end

    client =
      Client.new!(
        base_url: "http://localhost:4101/",
        transport: transport,
        context: %{
          journey_id: "journey-0001",
          traceparent: "00-4bf92f3577b34da6a3ce929c0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=value"
        }
      )

    adapter = MediaPlane.new!(client)

    assert :confirmed =
             MediaPlane.grant_publication(
               adapter,
               "operation-0000001",
               @session,
               @participant,
               :camera
             )

    assert_receive {:request, :post, url, headers, body,
                    [connect_timeout: 2_000, timeout: 5_000, ssl: []]}

    assert url == "http://localhost:4101/internal/v1/sync/provider-operations/operation-0000001"

    assert %{
             "effect" => "media.grant_publication",
             "tenant_id" => @tenant,
             "session_id" => @session_id,
             "participant_session_id" => @participant,
             "publication_source" => "camera"
           } = JSON.decode!(body)

    assert {"x-chalk-journey-id", "journey-0001"} in headers
    assert {"traceparent", "00-4bf92f3577b34da6a3ce929c0e0e4736-00f067aa0ba902b7-01"} in headers
    assert {"tracestate", "vendor=value"} in headers

    refute Enum.any?(JSON.decode!(body), fn {key, _value} ->
             key == "participant_session_generation"
           end)
  end

  test "recording callbacks use the fixed recording effects" do
    transport = fn _method, _url, _headers, body, _options ->
      payload = JSON.decode!(body)

      send(self(), {:effect, payload["effect"], payload["recording_id"]})

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => "recording-operation-0001",
         "effect" => payload["effect"],
         "outcome" => "satisfied"
       })}
    end

    adapter = RecordingPlane.new!(Client.new!(base_url: "http://localhost", transport: transport))

    assert :satisfied =
             RecordingPlane.start_recording(
               adapter,
               "recording-operation-0001",
               @session,
               @recording
             )

    assert_receive {:effect, "recording.start", @recording}

    assert :satisfied =
             RecordingPlane.stop_recording(
               adapter,
               "recording-operation-0001",
               @session,
               @recording
             )

    assert_receive {:effect, "recording.stop", @recording}
  end

  test "all media mutation callbacks retain their operation ids and effect names" do
    # The private response is keyed by the URL operation id, while the body
    # deliberately does not duplicate that path-owned field.
    transport = fn method, url, headers, body, options ->
      payload = JSON.decode!(body)
      operation_id = url |> String.split("/") |> List.last()
      send(self(), {:media_effect, method, headers, options, payload["effect"], payload})

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => operation_id,
         "effect" => payload["effect"],
         "outcome" => "confirmed"
       })}
    end

    adapter = MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: transport))

    assert :confirmed =
             MediaPlane.revoke_publication(
               adapter,
               "operation-revoke-0001",
               @session,
               @participant,
               :microphone
             )

    assert_receive {:media_effect, :post, _headers, _options, "media.revoke_publication", payload}
    assert payload["participant_session_id"] == @participant

    assert :confirmed =
             MediaPlane.remove_participant(
               adapter,
               "operation-remove-0001",
               @session,
               @participant
             )

    assert_receive {:media_effect, :post, _headers, _options, "media.remove_participant", payload}
    refute Map.has_key?(payload, "publication_source")

    assert :confirmed = MediaPlane.end_session(adapter, "operation-end-0001", @session)
    assert_receive {:media_effect, :post, _headers, _options, "media.end_session", payload}
    assert payload["tenant_id"] == @tenant
  end

  test "a safe generation resolver is the only source of participant generation" do
    transport = fn _method, _url, _headers, body, _options ->
      send(self(), {:payload, JSON.decode!(body)})

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => "operation-remove-0002",
         "effect" => "media.remove_participant",
         "outcome" => "confirmed"
       })}
    end

    adapter =
      MediaPlane.new!(
        Client.new!(base_url: "http://localhost", transport: transport),
        participant_generation_resolver: fn _session, @participant -> 7 end
      )

    assert :confirmed =
             MediaPlane.remove_participant(
               adapter,
               "operation-remove-0002",
               @session,
               @participant
             )

    assert_receive {:payload, %{"participant_session_generation" => 7}}
  end

  test "decodes all provider outcomes" do
    assert :confirmed = outcome_response("confirmed")
    assert :satisfied = outcome_response("satisfied")
    assert :ambiguous = outcome_response("ambiguous")

    assert {:retryable_failure, :recording_unavailable} =
             outcome_response("retryable_failure", "recording_unavailable")

    assert {:terminal_failure, :provider_denied} =
             outcome_response("terminal_failure", "provider_denied")
  end

  test "maps timeout, rate limiting, server failure, auth, and fingerprint conflict" do
    cases = [
      {{:error, :timeout}, {:retryable_failure, :timeout}},
      {{:ok, 429, [], "{}"}, {:retryable_failure, :rate_limited}},
      {{:ok, 503, [], "{}"}, {:retryable_failure, :provider_unavailable}},
      {{:ok, 400, [], "{}"}, {:terminal_failure, :invalid_contract}},
      {{:ok, 401, [], "{}"}, {:terminal_failure, :invalid_token}},
      {{:ok, 403, [], "{}"}, {:terminal_failure, :forbidden}},
      {{:ok, 409, [], JSON.encode!(%{"reason" => "fingerprint_conflict"})},
       {:terminal_failure, :fingerprint_conflict}},
      {{:ok, 500, [], JSON.encode!(%{"reason" => "fingerprint_conflict"})},
       {:retryable_failure, :provider_unavailable}}
    ]

    Enum.each(cases, fn {transport_result, expected} ->
      transport = fn _method, _url, _headers, _body, _options ->
        transport_result
      end

      adapter = MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: transport))

      assert expected == MediaPlane.end_session(adapter, "operation-status-0001", @session)
    end)
  end

  test "malformed and oversized responses are bounded retryable failures" do
    malformed = fn _method, _url, _headers, _body, _options -> {:ok, 200, [], "not-json"} end
    oversized = fn _method, _url, _headers, _body, _options -> {:ok, 200, [], "123456789"} end

    malformed_adapter =
      MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: malformed))

    assert {:retryable_failure, :malformed_response} =
             MediaPlane.end_session(malformed_adapter, "operation-malformed-1", @session)

    oversized_adapter =
      MediaPlane.new!(
        Client.new!(base_url: "http://localhost", transport: oversized, max_response_bytes: 4)
      )

    assert {:retryable_failure, :response_too_large} =
             MediaPlane.end_session(oversized_adapter, "operation-oversized-1", @session)
  end

  test "transport exceptions become retryable transport failures" do
    transport = fn _method, _url, _headers, _body, _options -> raise "transport down" end
    adapter = MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: transport))

    assert {:retryable_failure, :transport_error} =
             MediaPlane.end_session(adapter, "operation-exception-1", @session)
  end

  test "bounds request bytes before invoking the transport" do
    transport = fn _method, _url, _headers, _body, _options ->
      send(self(), :transport_called)
      {:ok, 200, [], "{}"}
    end

    adapter =
      MediaPlane.new!(
        Client.new!(base_url: "http://localhost", transport: transport, max_request_bytes: 4)
      )

    assert {:terminal_failure, :request_too_large} =
             MediaPlane.end_session(adapter, "operation-request-too-large-1", @session)

    refute_received :transport_called
  end

  test "enforces HTTPS for remote endpoints while allowing localhost HTTP" do
    assert {:error, :insecure_endpoint} =
             Client.new(
               base_url: "http://api.example.test",
               transport: fn _, _, _, _, _ -> :ok end
             )

    assert {:ok, _client} =
             Client.new(base_url: "http://localhost:4100", transport: fn _, _, _, _, _ -> :ok end)

    assert {:ok, _client} =
             Client.new(
               base_url: "https://api.example.test",
               transport: fn _, _, _, _, _ -> :ok end
             )

    assert {:error, :mtls_configuration_required} =
             Client.new(base_url: "https://api.example.test")
  end

  test "validates operation IDs and canonical UUID payload fields before transport" do
    transport = fn _method, _url, _headers, _body, _options ->
      send(self(), :transport_called)

      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => "operation-valid-01",
         "effect" => "media.end_session",
         "outcome" => "confirmed"
       })}
    end

    adapter = MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: transport))

    assert {:terminal_failure, :invalid_contract} =
             MediaPlane.end_session(adapter, "short", @session)

    refute_received :transport_called

    invalid_session = %SessionKey{
      tenant_id: "not-a-uuid",
      room_id: @room,
      session_id: @session_id
    }

    assert {:terminal_failure, :invalid_contract} =
             MediaPlane.end_session(adapter, "operation-invalid-01", invalid_session)

    refute_received :transport_called
  end

  test "requires paired nonnegative observation cursors" do
    transport = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{"observations" => [], "has_more" => false, "next_cursor" => nil})}
    end

    client = Client.new!(base_url: "http://localhost", transport: transport)

    assert {:error, :invalid_cursor} =
             Client.observe_session_publications(client, @session, after_incarnation: 1)

    assert {:error, :invalid_cursor} =
             Client.observe_session_publications(client, @session, after_sequence: 1)

    assert {:ok, %{incarnation: 0, sequence: 0, publications: []}} =
             Client.observe_session_publications(client, @session,
               after_incarnation: 0,
               after_sequence: 0
             )
  end

  test "decodes ordered observations with opaque publication identifiers" do
    transport = fn method, url, _headers, _body, _options ->
      send(self(), {:get, method, url})

      {:ok, 200, [],
       JSON.encode!(%{
         "observations" => [
           %{
             "incarnation" => 4,
             "sequence" => 8,
             "publications" => []
           },
           %{
             "incarnation" => 4,
             "sequence" => 9,
             "publications" => [
               %{
                 "participant_session_id" => @participant,
                 "source" => "camera",
                 "enabled" => true,
                 "publication_id" => "cf:session-1:camera-track"
               }
             ]
           }
         ],
         "has_more" => true,
         "next_cursor" => %{"incarnation" => 4, "sequence" => 9}
       })}
    end

    client =
      Client.new!(base_url: "http://localhost:4100", transport: transport, max_observations: 4)

    assert {:ok, %{incarnation: 4, sequence: 9, publications: [publication]}} =
             Client.observe_session_publications(client, @session,
               after_incarnation: 3,
               after_sequence: 7,
               limit: 4
             )

    assert publication == %{
             participant_session_id: @participant,
             source: :camera,
             enabled: true,
             publication_id: "cf:session-1:camera-track"
           }

    assert_receive {:get, :get, url}

    assert url ==
             "http://localhost:4100/internal/v1/sync/media-observations?tenant_id=#{@tenant}&session_id=#{@session_id}&after_incarnation=3&after_sequence=7&limit=4"
  end

  test "bounds observation and publication counts and rejects unknown sources" do
    too_many_observations = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{
         "observations" => [
           %{"incarnation" => 1, "sequence" => 1, "publications" => []},
           %{"incarnation" => 1, "sequence" => 2, "publications" => []}
         ],
         "has_more" => true,
         "next_cursor" => %{"incarnation" => 1, "sequence" => 2}
       })}
    end

    client =
      Client.new!(
        base_url: "http://localhost",
        transport: too_many_observations,
        max_observations: 1
      )

    assert {:error, :observation_limit} = Client.observe_session_publications(client, @session)

    unknown_source = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{
         "observations" => [
           %{
             "incarnation" => 1,
             "sequence" => 1,
             "publications" => [
               %{
                 "participant_session_id" => "p",
                 "source" => "speaker",
                 "enabled" => true,
                 "publication_id" => "opaque-track"
               }
             ]
           }
         ],
         "has_more" => false,
         "next_cursor" => nil
       })}
    end

    client = Client.new!(base_url: "http://localhost", transport: unknown_source)
    assert {:error, :invalid_source} = Client.observe_session_publications(client, @session)

    out_of_order = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{
         "observations" => [
           %{"incarnation" => 2, "sequence" => 3, "publications" => []},
           %{"incarnation" => 1, "sequence" => 4, "publications" => []}
         ],
         "has_more" => false,
         "next_cursor" => nil
       })}
    end

    client = Client.new!(base_url: "http://localhost", transport: out_of_order)
    assert {:error, :malformed_response} = Client.observe_session_publications(client, @session)
  end

  test "preserves bounded opaque publication identifiers at the private boundary" do
    transport = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{
         "observations" => [
           %{
             "incarnation" => 1,
             "sequence" => 1,
             "publications" => [
               %{
                 "participant_session_id" => @participant,
                 "source" => "camera",
                 "enabled" => true,
                 "publication_id" => "provider-id"
               }
             ]
           }
         ],
         "has_more" => false,
         "next_cursor" => nil
       })}
    end

    client = Client.new!(base_url: "http://localhost", transport: transport)

    assert {:ok, %{publications: [%{publication_id: "provider-id"}]}} =
             Client.observe_session_publications(client, @session)
  end

  test "rejects operation response contract drift and mismatched observation cursors" do
    unknown_key = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{
         "operation_id" => "operation-outcome-0001",
         "effect" => "media.end_session",
         "outcome" => "confirmed",
         "provider_id" => "private"
       })}
    end

    adapter = MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: unknown_key))

    assert {:retryable_failure, :malformed_response} =
             MediaPlane.end_session(adapter, "operation-outcome-0001", @session)

    mismatched_cursor = fn _method, _url, _headers, _body, _options ->
      {:ok, 200, [],
       JSON.encode!(%{
         "observations" => [%{"incarnation" => 1, "sequence" => 1, "publications" => []}],
         "has_more" => true,
         "next_cursor" => %{"incarnation" => 1, "sequence" => 2}
       })}
    end

    client = Client.new!(base_url: "http://localhost", transport: mismatched_cursor)
    assert {:error, :malformed_response} = Client.observe_session_publications(client, @session)
  end

  defp outcome_response(outcome, reason \\ nil) do
    transport = fn _method, _url, _headers, _body, _options ->
      payload = %{
        "operation_id" => "operation-outcome-0001",
        "effect" => "media.end_session",
        "outcome" => outcome
      }

      payload = if reason, do: Map.put(payload, "reason", reason), else: payload
      {:ok, 200, [], JSON.encode!(payload)}
    end

    adapter = MediaPlane.new!(Client.new!(base_url: "http://localhost", transport: transport))
    MediaPlane.end_session(adapter, "operation-outcome-0001", @session)
  end
end
