defmodule ChalkSync.ExternalOperationConsumerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.RecordingPlaneTestAdapter
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.SessionKey

  @operation_id "00000000-0000-4000-8000-000000000010"
  @participant_id "00000000-0000-4000-8000-000000000011"
  @recording_id "00000000-0000-4000-8000-000000000012"

  test "dispatches every local operation through authoritative local confirmation" do
    for name <- [
          :admit_participant,
          :deny_admission,
          :admission_request_expired,
          :tenant_transfer_host,
          :tenant_set_deadline
        ] do
      assert :confirmed = execute(operation(name), nil, nil)
      assert_received {:finalize, @operation_id, {:confirmed, :local}}
    end
  end

  test "dispatches every media operation with the stable external operation id" do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    media_plane = {MediaPlaneTestAdapter, adapter}

    cases = [
      {:mute_participant, :revoke_publication, :microphone},
      {:stop_participant_camera, :revoke_publication, :camera},
      {:stop_participant_screen_share, :revoke_publication, :screen},
      {:role_transition_source_stop, :revoke_publication, :camera},
      {:remove_participant, :remove_participant, nil},
      {:participant_leave, :remove_participant, nil},
      {:end_session, :end_session, nil},
      {:tenant_end_session, :end_session, nil},
      {:maximum_duration_expired, :end_session, nil}
    ]

    for {name, callback, source} <- cases do
      assert :confirmed = execute(operation(name, source: source), media_plane, nil)
      assert_received {:finalize, @operation_id, {:confirmed, :provider}}

      assert {^callback, @operation_id, _arguments} =
               List.last(MediaPlaneTestAdapter.calls(adapter))
    end
  end

  test "dispatches recording operations through the recording port" do
    {:ok, adapter} = RecordingPlaneTestAdapter.start_link()
    recording_plane = {RecordingPlaneTestAdapter, adapter}

    for name <- [:start_recording, :stop_recording] do
      assert :confirmed = execute(operation(name), nil, recording_plane)
      assert_received {:finalize, @operation_id, {:confirmed, :recording}}

      assert {^name, @operation_id, [_session, @recording_id]} =
               List.last(RecordingPlaneTestAdapter.calls(adapter))
    end
  end

  test "end operations require both media and active recording cleanup confirmation" do
    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()
    {:ok, recording_adapter} = RecordingPlaneTestAdapter.start_link()

    for name <- [:end_session, :tenant_end_session, :maximum_duration_expired] do
      assert :confirmed =
               execute(
                 operation(name, recording_id: @recording_id),
                 {MediaPlaneTestAdapter, media_adapter},
                 {RecordingPlaneTestAdapter, recording_adapter}
               )

      assert_received {:finalize, @operation_id, {:confirmed, :provider}}

      assert {:end_session, @operation_id, [_session]} =
               List.last(MediaPlaneTestAdapter.calls(media_adapter))

      assert {:stop_recording, @operation_id, [_session, @recording_id]} =
               List.last(RecordingPlaneTestAdapter.calls(recording_adapter))
    end
  end

  test "end operations without an active recording require only media confirmation" do
    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()

    assert :confirmed =
             execute(
               operation(:end_session),
               {MediaPlaneTestAdapter, media_adapter},
               nil
             )

    assert_received {:finalize, @operation_id, {:confirmed, :provider}}

    assert [{:end_session, @operation_id, [_session]}] =
             MediaPlaneTestAdapter.calls(media_adapter)
  end

  test "end cleanup retains pending when either provider is unconfirmed" do
    cases = [
      {:ambiguous, :confirmed},
      {:confirmed, {:retryable_failure, :recording_unavailable}}
    ]

    for {media_outcome, recording_outcome} <- cases do
      {:ok, media_adapter} =
        MediaPlaneTestAdapter.start_link(outcomes: %{end_session: media_outcome})

      {:ok, recording_adapter} =
        RecordingPlaneTestAdapter.start_link(
          outcomes: %{{:stop_recording, @operation_id} => recording_outcome}
        )

      assert :pending =
               execute(
                 operation(:end_session, recording_id: @recording_id),
                 {MediaPlaneTestAdapter, media_adapter},
                 {RecordingPlaneTestAdapter, recording_adapter}
               )

      assert [{:end_session, @operation_id, _arguments}] =
               MediaPlaneTestAdapter.calls(media_adapter)

      assert [{:stop_recording, @operation_id, _arguments}] =
               RecordingPlaneTestAdapter.calls(recording_adapter)

      refute_received {:finalize, _, _}
    end
  end

  test "end cleanup retains pending when the required recording provider is missing" do
    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()

    assert :pending =
             execute(
               operation(:end_session, recording_id: @recording_id),
               {MediaPlaneTestAdapter, media_adapter},
               nil
             )

    assert [{:end_session, @operation_id, _arguments}] =
             MediaPlaneTestAdapter.calls(media_adapter)

    refute_received {:finalize, _, _}
  end

  test "end cleanup finalizes a stable terminal failure from either provider" do
    cases = [
      {{:terminal_failure, :media_rejected}, :confirmed, :media_rejected},
      {:confirmed, {:terminal_failure, :recording_rejected}, :recording_rejected}
    ]

    for {media_outcome, recording_outcome, reason} <- cases do
      {:ok, media_adapter} =
        MediaPlaneTestAdapter.start_link(outcomes: %{end_session: media_outcome})

      {:ok, recording_adapter} =
        RecordingPlaneTestAdapter.start_link(
          outcomes: %{{:stop_recording, @operation_id} => recording_outcome}
        )

      assert :terminal_failure =
               execute(
                 operation(:end_session, recording_id: @recording_id),
                 {MediaPlaneTestAdapter, media_adapter},
                 {RecordingPlaneTestAdapter, recording_adapter}
               )

      assert_received {:finalize, @operation_id, {:failed, ^reason}}
    end
  end

  test "end cleanup aggregates both providers under one timeout" do
    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()

    assert :pending =
             execute(
               operation(:end_session, recording_id: @recording_id),
               {MediaPlaneTestAdapter, media_adapter},
               {__MODULE__.BlockingRecordingPlane, self()},
               {:ok, %{result: :applied}},
               10
             )

    assert_received :recording_cleanup_started
    refute_received {:finalize, _, _}
  end

  test "end cleanup retry exhaustion finalizes instead of retaining pending forever" do
    {:ok, media_adapter} = MediaPlaneTestAdapter.start_link()

    {:ok, recording_adapter} =
      RecordingPlaneTestAdapter.start_link(
        outcomes: %{{:stop_recording, @operation_id} => :ambiguous}
      )

    exhausted = %{
      operation(:end_session, recording_id: @recording_id)
      | attempt_count: 100
    }

    assert :terminal_failure =
             execute(
               exhausted,
               {MediaPlaneTestAdapter, media_adapter},
               {RecordingPlaneTestAdapter, recording_adapter}
             )

    assert_received {:finalize, @operation_id, {:failed, :retry_exhausted}}
  end

  test "satisfied provider state is confirmed without pretending it was newly applied" do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link(outcomes: %{remove_participant: :satisfied})

    assert :confirmed =
             execute(operation(:remove_participant), {MediaPlaneTestAdapter, adapter}, nil)

    assert_received {:finalize, @operation_id, {:confirmed, :provider}}
  end

  test "terminal provider failure is finalized with its stable reason" do
    {:ok, adapter} =
      MediaPlaneTestAdapter.start_link(
        outcomes: %{remove_participant: {:terminal_failure, :provider_rejected}}
      )

    assert :terminal_failure =
             execute(operation(:remove_participant), {MediaPlaneTestAdapter, adapter}, nil)

    assert_received {:finalize, @operation_id, {:failed, :provider_rejected}}
    refute_received {:finalize, @operation_id, {:confirmed, _authority}}
  end

  test "ambiguous, retryable, invalid, and missing adapters retain pending work" do
    outcomes = [:ambiguous, {:retryable_failure, :provider_unavailable}, :unexpected]

    for outcome <- outcomes do
      {:ok, adapter} = MediaPlaneTestAdapter.start_link(outcomes: %{remove_participant: outcome})

      assert :pending =
               execute(operation(:remove_participant), {MediaPlaneTestAdapter, adapter}, nil)

      refute_received {:finalize, _, _}
    end

    assert :pending = execute(operation(:remove_participant), nil, nil)
    assert :pending = execute(operation(:start_recording), nil, nil)
    refute_received {:finalize, _, _}
  end

  test "retry exhaustion turns ambiguous work into a stable terminal failure" do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link(outcomes: %{remove_participant: :ambiguous})
    exhausted = %{operation(:remove_participant) | attempt_count: 100}

    assert :terminal_failure =
             execute(exhausted, {MediaPlaneTestAdapter, adapter}, nil)

    assert_received {:finalize, @operation_id, {:failed, :retry_exhausted}}
  end

  test "adapter exceptions retain pending work without reporting success" do
    assert :pending =
             execute(
               operation(:remove_participant),
               {__MODULE__.RaisingMediaPlane, :adapter},
               nil
             )

    refute_received {:finalize, _, _}
  end

  test "adapter calls are time-bounded and retain unconfirmed work" do
    assert :pending =
             execute(
               operation(:remove_participant),
               {__MODULE__.BlockingMediaPlane, self()},
               nil,
               {:ok, %{result: :applied}},
               10
             )

    assert_received :adapter_started
    refute_received {:finalize, _, _}
  end

  test "a duplicate execution preserves the id for provider and finalization idempotency" do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    media_plane = {MediaPlaneTestAdapter, adapter}
    operation = operation(:remove_participant)

    assert :confirmed = execute(operation, media_plane, nil, {:ok, %{result: :applied}})
    assert :confirmed = execute(operation, media_plane, nil, {:ok, %{result: :duplicate}})

    assert [
             {:remove_participant, @operation_id, _},
             {:remove_participant, @operation_id, _}
           ] = MediaPlaneTestAdapter.calls(adapter)

    assert_received {:finalize, @operation_id, {:confirmed, :provider}}
    assert_received {:finalize, @operation_id, {:confirmed, :provider}}
  end

  test "finalization uncertainty is never counted as confirmed" do
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()

    assert :finalization_failure =
             execute(
               operation(:remove_participant),
               {MediaPlaneTestAdapter, adapter},
               nil,
               {:retryable, :decision_unavailable}
             )
  end

  test "bounds dependency backoff while healthy polls retain their configured interval" do
    assert ExternalOperationConsumer.backoff_delay(100, 5_000, 0) == 100
    assert ExternalOperationConsumer.backoff_delay(100, 5_000, 1) == 100
    assert ExternalOperationConsumer.backoff_delay(100, 5_000, 2) == 200
    assert ExternalOperationConsumer.backoff_delay(100, 5_000, 7) == 5_000
    assert ExternalOperationConsumer.backoff_delay(100, 5_000, 100) == 5_000
  end

  defp execute(
         operation,
         media_plane,
         recording_plane,
         finalization \\ {:ok, %{result: :applied}},
         timeout_ms \\ 5_000
       ) do
    test = self()

    ExternalOperationConsumer.execute_operation(
      session(),
      operation,
      media_plane,
      recording_plane,
      fn _session, operation_id, outcome ->
        send(test, {:finalize, operation_id, outcome})
        finalization
      end,
      timeout_ms
    )
  end

  defp operation(name, options \\ []) do
    recording_id =
      Keyword.get_lazy(options, :recording_id, fn ->
        if name in [:start_recording, :stop_recording], do: @recording_id
      end)

    %ExternalOperation{
      external_operation_id: @operation_id,
      request_key: "request_key_0001",
      request_fingerprint: <<0::256>>,
      name: name,
      payload: %{},
      status: :pending,
      attempt_count: 1,
      target_participant_session_id: @participant_id,
      target_participant_generation: 1,
      source: Keyword.get(options, :source),
      recording_id: recording_id
    }
  end

  defp session do
    %SessionKey{
      tenant_id: "00000000-0000-4000-8000-000000000001",
      room_id: "00000000-0000-4000-8000-000000000002",
      session_id: "00000000-0000-4000-8000-000000000003"
    }
  end

  defmodule RaisingMediaPlane do
    def remove_participant(_adapter, _operation_id, _session, _participant_id),
      do: raise("provider failed before confirmation")
  end

  defmodule BlockingMediaPlane do
    def remove_participant(test, _operation_id, _session, _participant_id) do
      send(test, :adapter_started)
      Process.sleep(:infinity)
    end
  end

  defmodule BlockingRecordingPlane do
    def stop_recording(test, _operation_id, _session, _recording_id) do
      send(test, :recording_cleanup_started)
      Process.sleep(:infinity)
    end
  end
end
