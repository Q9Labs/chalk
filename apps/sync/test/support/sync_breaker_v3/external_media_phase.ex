defmodule ChalkSync.SyncBreakerV3.ExternalMediaPhase do
  @moduledoc false

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Live.Session, as: LiveSession
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncBreakerV3.ScriptedMediaPlane
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @name "external-operation-live-media"
  @schedule [
    "moderation confirmation",
    "moderation terminal failure",
    "ambiguity before provider effect and reconciliation retry",
    "provider effect followed by lost confirmation response",
    "crash after provider confirmation before PostgreSQL finalization",
    "removal cleanup",
    "recording start, concurrent start rejection, and stop",
    "accepted moderation serialized before role authority change",
    "two simultaneous screen starts serialize on one PostgreSQL lease",
    "confirmed publication loss releases the screen lease",
    "older provider snapshot is applied through production reconciliation to test stale fencing",
    "controller restart preserves provider truth through production reconciliation"
  ]

  def run!(database_url, seed \\ 730_031) do
    connections = SyncPostgres.start_connections(database_url, 6)
    previous = install(connections)

    try do
      fixture = SyncPostgres.seed_session(hd(connections), 3)

      try do
        execute(fixture, seed)
      after
        SyncPostgres.cleanup(hd(connections), fixture.session)
      end
    after
      restore(previous)
      Enum.each(connections, &stop/1)
    end
  end

  defp execute(fixture, seed) do
    [host, guest, contender] = fixture.identities
    recording_id = UUID.generate()

    actions = [
      {:revoke_publication, :confirmed},
      {:revoke_publication, {:terminal_failure, :provider_denied}},
      {:revoke_publication, :ambiguous_before_effect},
      {:revoke_publication, :confirmed},
      {:revoke_publication, :confirmed},
      {:revoke_publication, :confirmed},
      {:remove_participant, :effect_applied_then_response_lost},
      {:remove_participant, :confirmed},
      {:start_recording, :confirmed},
      {:stop_recording, :confirmed},
      {:revoke_publication, {:hold_before_effect, :role_moderation}},
      {:grant_publication, {:hold_after_effect, :screen_start}},
      {:observe_session_publications, :observe}
    ]

    {:ok, controller} = ScriptedMediaPlane.start_controller(actions)
    adapter = ScriptedMediaPlane.adapter(controller)
    media = {ScriptedMediaPlane, adapter}
    recording = {ScriptedMediaPlane, adapter}

    confirmed =
      operation!(host, :mute_participant, guest, "breaker_media_mute_01", media, recording)

    failed =
      operation!(host, :stop_participant_camera, guest, "breaker_media_camera1", media, recording)

    {ambiguous_id, ambiguous_claim, _ambiguous_receipt} =
      begin_and_claim!(host, :stop_participant_screen_share, guest, "breaker_media_screen1")

    :pending = execute_claim(ambiguous_claim, media, recording)
    :confirmed = execute_claim(ambiguous_claim, media, recording)
    crash_retry = crash_after_confirmation(host, contender, media, recording, fixture.session)

    {remove_id, remove_claim, _remove_receipt} =
      begin_and_claim!(host, :remove_participant, guest, "breaker_media_remove1")

    :pending = execute_claim(remove_claim, media, recording)
    :confirmed = execute_claim(remove_claim, media, recording)

    recording_start =
      recording_operation!(
        host,
        :start_recording,
        recording_id,
        "breaker_record_start1",
        media,
        recording
      )

    {:ok, concurrent} =
      recording_operation(host, :start_recording, UUID.generate(), "breaker_record_start2")

    recording_stop =
      recording_operation!(
        host,
        :stop_recording,
        recording_id,
        "breaker_record_stop01",
        media,
        recording
      )

    role_race = role_moderation_barrier(host, contender, media, recording)
    screen = screen_race(fixture, host, contender, controller, adapter)
    stale_observation = stale_observation_probe(fixture.session, host)
    restart_reconciliation = restart_reconciliation_probe(fixture.session, host)

    states =
      [confirmed.id, failed.id, ambiguous_id, remove_id, recording_start.id, recording_stop.id]
      |> Enum.map(&operation_state(fixture.session, &1))

    effects = ScriptedMediaPlane.effects(controller)
    calls = ScriptedMediaPlane.calls(controller)
    provider_projection = phase_projection(ScriptedMediaPlane.projection(controller))
    stop(controller)

    %{
      "name" => @name,
      "seed" => seed,
      "schedule" => @schedule,
      "receipts" => [
        receipt("mute_participant", confirmed),
        receipt("stop_participant_camera", failed),
        receipt("start_recording", recording_start),
        receipt("stop_recording", recording_stop)
      ],
      "observations" => %{
        "operation_states" => states,
        "concurrent_recording" => normalize_decision(concurrent),
        "role_moderation" => role_race,
        "confirmation_crash_retry" => crash_retry,
        "screen_race" => screen,
        "stale_observation" => stale_observation,
        "restart_reconciliation" => restart_reconciliation
      },
      "evidence" => %{
        "call_count" => length(calls),
        "effect_count" => length(effects),
        "remove_effect_count" => effect_count(effects, :remove_participant, remove_id),
        "ambiguous_effect_count" => effect_count(effects, :revoke_publication, ambiguous_id)
      },
      "intent_states" => Enum.map(states, & &1["status"]),
      "provider_projection" => provider_projection,
      "bounds" => ScriptedMediaPlane.bounds(),
      "invariants" => %{
        "stable_external_operation_deduplication" =>
          effect_count(effects, :remove_participant, remove_id) == 1,
        "pending_ambiguity_reconciled" =>
          operation_state(fixture.session, ambiguous_id)["status"] == "applied",
        "confirmation_crash_retry_deduplicated" => crash_retry["effect_count"] == 1,
        "single_screen_lease" => screen["lease_count_during_race"] == 1,
        "publication_loss_releases_lease" => screen["lease_count_after_loss"] == 0,
        "recording_concurrency_fenced" => concurrent.result != :pending,
        "stale_observation_does_not_overwrite_newer_projection" =>
          stale_observation["older_snapshot_ignored"],
        "restart_reconciliation_preserves_provider_truth" =>
          restart_reconciliation["production_projection_matches_provider_truth"]
      },
      "verdict" => "pass"
    }
  end

  defp operation!(actor, name, target, key, media, recording) do
    {id, claim, decision} = begin_and_claim!(actor, name, target, key)
    result = execute_claim(claim, media, recording)
    %{id: id, acceptance: decision.result, result: result}
  end

  defp begin_and_claim!(actor, name, target, key) do
    {:ok, operation} =
      Operation.new(key, name, %{"participantSessionId" => target.participant_session_id})

    {:ok, decision} = Postgres.begin_operation(actor, operation)
    {:ok, claimed} = Postgres.claim_operations(64)

    {session, claim} =
      Enum.find(claimed, fn {_session, item} ->
        item.external_operation_id == decision.external_operation_id
      end)

    {decision.external_operation_id, {session, claim}, decision}
  end

  defp execute_claim({session, claim}, media, recording) do
    ExternalOperationConsumer.execute_operation(
      session,
      claim,
      media,
      recording,
      &Postgres.finalize_operation/3
    )
  end

  defp recording_operation!(actor, name, recording_id, key, media, recording) do
    {:ok, decision} = recording_operation(actor, name, recording_id, key)
    {:ok, claimed} = Postgres.claim_operations(64)

    pair =
      Enum.find(claimed, fn {_session, item} ->
        item.external_operation_id == decision.external_operation_id
      end)

    result = execute_claim(pair, media, recording)
    %{id: decision.external_operation_id, acceptance: decision.result, result: result}
  end

  defp recording_operation(actor, name, recording_id, key) do
    {:ok, operation} = Operation.new(key, name, %{"recordingId" => recording_id})
    Postgres.begin_operation(actor, operation)
  end

  defp role_moderation_barrier(host, target, media, recording) do
    {:ok, promote} =
      Command.new("breaker_role_promote1", :set_participant_role, %{
        "participantSessionId" => target.participant_session_id,
        "role" => "cohost"
      })

    {:ok, %{result: :committed}} = Postgres.begin_role_transition(host, promote, [])

    {id, claim, _receipt} =
      begin_and_claim!(host, :mute_participant, target, "breaker_role_moderate1")

    task = Task.async(fn -> execute_claim(claim, media, recording) end)
    assert_barrier!(:role_moderation, :before_effect)

    {:ok, command} =
      Command.new("breaker_role_change01", :set_participant_role, %{
        "participantSessionId" => target.participant_session_id,
        "role" => "participant"
      })

    {:ok, role_decision} = Postgres.begin_role_transition(host, command, [])
    :ok = ScriptedMediaPlane.release(elem(media, 1).controller, :role_moderation)
    moderation_result = Task.await(task)

    %{
      "initial_role" => "cohost",
      "locked_order" => [
        "moderation_accepted",
        "provider_held",
        "role_demoted",
        "moderation_finalized"
      ],
      "moderation_result" => Atom.to_string(moderation_result),
      "moderation_status" => operation_state(elem(claim, 0), id)["status"],
      "role_result" => Atom.to_string(role_decision.result),
      "final_role" => "participant"
    }
  end

  defp crash_after_confirmation(host, target, media, recording, session) do
    {id, claim, _receipt} =
      begin_and_claim!(host, :mute_participant, target, "breaker_confirm_crash1")

    Application.put_env(:chalk_sync, :external_operation_fault_hook, fn point, _context ->
      if point == :after_provider_confirmation_before_finalize,
        do: raise("breaker confirmation crash")
    end)

    try do
      try do
        execute_claim(claim, media, recording)
      rescue
        RuntimeError -> :crashed
      end

      pending = operation_state(session, id)
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
      :confirmed = execute_claim(claim, media, recording)
      effects = ScriptedMediaPlane.effects(elem(media, 1).controller)

      %{
        "pending_after_crash" => pending["status"] == "pending",
        "final_status" => operation_state(session, id)["status"],
        "effect_count" => effect_count(effects, :revoke_publication, id)
      }
    after
      Application.delete_env(:chalk_sync, :external_operation_fault_hook)
    end
  end

  defp screen_race(fixture, first, second, controller, adapter) do
    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {ScriptedMediaPlane, adapter})

    try do
      target = %{operation_id: UUID.generate(), name: :set_screen_share_enabled, enabled: true}

      one =
        Task.async(fn ->
          LiveSession.live_target(LiveSession.new(fixture.session), first, target)
        end)

      assert_barrier!(:screen_start, :after_effect)

      {_state, second_result} =
        LiveSession.live_target(LiveSession.new(fixture.session), second, %{
          target
          | operation_id: UUID.generate()
        })

      :ok = ScriptedMediaPlane.release(controller, :screen_start)
      {state, first_result} = Task.await(one)
      {:ok, state, _projection} = LiveSession.reconcile(state)
      lease_count = map_size(state.screen_leases)

      :applied =
        ScriptedMediaPlane.confirmed_publication_loss(
          controller,
          fixture.session,
          first.participant_session_id,
          :screen
        )

      {:ok, state, _loss_projection} = LiveSession.reconcile(state)

      %{
        "first" => first_result["outcome"],
        "second" => second_result["outcome"],
        "lease_count_during_race" => lease_count,
        "lease_count_after_loss" => map_size(state.screen_leases)
      }
    after
      restore_env(:media_plane, previous)
    end
  end

  defp stale_observation_probe(session, identity) do
    actions = [
      {:observe_session_publications, :observe},
      {:observe_session_publications, {:stale_observation, 1}}
    ]

    {:ok, controller} = ScriptedMediaPlane.start_controller(actions)
    adapter = ScriptedMediaPlane.adapter(controller)

    :confirmed =
      ScriptedMediaPlane.grant_publication(
        adapter,
        "stale-probe-camera",
        session,
        identity.participant_session_id,
        :camera
      )

    :confirmed =
      ScriptedMediaPlane.grant_publication(
        adapter,
        "stale-probe-screen",
        session,
        identity.participant_session_id,
        :screen
      )

    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {ScriptedMediaPlane, adapter})

    try do
      {:ok, newer, [%{"items" => newer_items}]} =
        LiveSession.reconcile(LiveSession.new(session))

      {:ok, preserved, []} = LiveSession.reconcile(newer)

      %{
        "newer_projection_item_count" => length(newer_items),
        "production_item_count_after_older_snapshot" => length(preserved.media_items),
        "cursor_after_newer_snapshot" => cursor(newer.media_observation_cursor),
        "cursor_after_older_snapshot" => cursor(preserved.media_observation_cursor),
        "older_snapshot_ignored" => preserved == newer
      }
    after
      restore_env(:media_plane, previous)
      stop(controller)
    end
  end

  defp restart_reconciliation_probe(session, identity) do
    {:ok, original} = ScriptedMediaPlane.start_controller()
    original_adapter = ScriptedMediaPlane.adapter(original)

    :confirmed =
      ScriptedMediaPlane.grant_publication(
        original_adapter,
        "restart-probe-camera",
        session,
        identity.participant_session_id,
        :camera
      )

    provider_truth = ScriptedMediaPlane.projection(original)
    {:ok, restarted} = ScriptedMediaPlane.restart_controller(original)
    stop(original)
    restarted_adapter = ScriptedMediaPlane.adapter(restarted)
    previous = Application.get_env(:chalk_sync, :media_plane)
    Application.put_env(:chalk_sync, :media_plane, {ScriptedMediaPlane, restarted_adapter})

    try do
      {:ok, live, [%{"items" => items}]} = LiveSession.reconcile(LiveSession.new(session))

      %{
        "original_controller_stopped" => not Process.alive?(original),
        "provider_publication_count" => length(provider_truth["publications"]),
        "restarted_incarnation" => ScriptedMediaPlane.projection(restarted)["incarnation"],
        "production_publication_count" => length(items),
        "production_projection_matches_provider_truth" =>
          length(live.media_items) == length(provider_truth["publications"])
      }
    after
      restore_env(:media_plane, previous)
      stop(restarted)
    end
  end

  defp assert_barrier!(tag, point) do
    receive do
      {:scripted_media_barrier, ^tag, ^point} -> :ok
    after
      2_000 -> raise "scripted media barrier not reached"
    end
  end

  defp operation_state(session, id) do
    {:ok, operation} = Postgres.read_operation(session, id)

    %{
      "status" => Atom.to_string(operation.status),
      "attempt_count" => operation.attempt_count
    }
  end

  defp effect_count(effects, operation, id),
    do: Enum.count(effects, &(&1.operation == operation and &1.operation_id == id))

  defp receipt(operation, evidence) do
    %{
      "operation" => operation,
      "acceptance" => Atom.to_string(evidence.acceptance),
      "execution" => Atom.to_string(evidence.result)
    }
  end

  defp normalize_decision(decision),
    do: %{
      "result" => Atom.to_string(decision.result),
      "reason" => decision.reason && Atom.to_string(decision.reason)
    }

  defp cursor({incarnation, sequence}),
    do: %{"incarnation" => incarnation, "sequence" => sequence}

  defp phase_projection(projection) do
    %{
      "publication_count" => length(projection["publications"]),
      "publication_sources" =>
        projection["publications"] |> Enum.map(& &1["source"]) |> Enum.sort(),
      "recording_count" => length(projection["recordings"]),
      "incarnation" => projection["incarnation"],
      "observation_version" => projection["observation_version"]
    }
  end

  defp install(connections) do
    keys = [:stateholder, :database_connections, :media_plane, :external_operation_fault_hook]
    previous = Map.new(keys, &{&1, Application.get_env(:chalk_sync, &1)})
    Application.put_env(:chalk_sync, :stateholder, Postgres)
    Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))
    previous
  end

  defp restore(previous), do: Enum.each(previous, fn {key, value} -> restore_env(key, value) end)
  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
  defp stop(pid), do: if(Process.alive?(pid), do: GenServer.stop(pid))
end
