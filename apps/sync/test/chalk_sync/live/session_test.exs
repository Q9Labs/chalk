defmodule ChalkSync.Live.SessionTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Live.MediaPlaneTestAdapter
  alias ChalkSync.Live.Session
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  defmodule Authority do
    def participant_authority(_session, participant_session_id, generation) do
      send(controller(), {:participant_authority, participant_session_id, generation})
      {:ok, Process.get({__MODULE__, :authority})}
    end

    def reserve_publication_grant(_identity, operation_id, source) do
      send(controller(), {:reserve_publication_grant, operation_id, source})
      {:ok, %{reservation_id: "00000000-0000-4000-8000-000000000090"}}
    end

    def complete_publication_grant(_session, reservation_id, outcome) do
      send(controller(), {:complete_publication_grant, reservation_id, outcome})
      Process.get({__MODULE__, :completion})
    end

    defp controller, do: Process.get({__MODULE__, :controller})
  end

  defmodule UnavailableMediaPlane do
    def observe_session_publications(_adapter, _session), do: raise("observation failed")

    def grant_publication(_adapter, _operation_id, _session, _participant_id, _source),
      do: Process.sleep(:infinity)

    def revoke_publication(_adapter, _operation_id, _session, _participant_id, _source),
      do: raise("revoke failed")
  end

  setup do
    previous_stateholder = Application.get_env(:chalk_sync, :stateholder)
    previous_media_plane = Application.get_env(:chalk_sync, :media_plane)
    {:ok, adapter} = MediaPlaneTestAdapter.start_link()
    Application.put_env(:chalk_sync, :stateholder, Authority)
    Application.put_env(:chalk_sync, :media_plane, {MediaPlaneTestAdapter, adapter})

    Process.put({Authority, :controller}, self())
    Process.put({Authority, :authority}, authority())
    Process.put({Authority, :completion}, {:ok, %{result: :authorized}})

    on_exit(fn ->
      restore_env(:stateholder, previous_stateholder)
      restore_env(:media_plane, previous_media_plane)
    end)

    {:ok, adapter: adapter}
  end

  test "reserves publication authority before provider grant and completes afterward", %{
    adapter: adapter
  } do
    identity = identity()
    participant_id = identity.participant_session_id
    session = identity.session
    target = target("camera-grant-order-01")

    assert {_state, %{"outcome" => "confirmed"}} =
             Session.live_target(Session.new(identity.session), identity, target)

    assert_receive {:participant_authority, ^participant_id, 1}
    assert_receive {:reserve_publication_grant, "camera-grant-order-01", :camera}

    assert [
             {:grant_publication, "camera-grant-order-01", [^session, ^participant_id, :camera]}
           ] = MediaPlaneTestAdapter.calls(adapter)

    assert_receive {:complete_publication_grant, "00000000-0000-4000-8000-000000000090",
                    :confirmed}
  end

  test "cleanup-required completion returns a stable terminal authority failure" do
    Process.put({Authority, :completion}, {:ok, %{result: :cleanup_required}})
    identity = identity()

    assert {_state, %{"outcome" => "terminal_failure", "error_code" => "authority_changed"}} =
             Session.live_target(
               Session.new(identity.session),
               identity,
               target("camera-cleanup-required-01")
             )
  end

  test "ambiguous grant converges to confirmed with the same operation id", %{adapter: adapter} do
    operation_id = "camera-ambiguous-retry-01"
    MediaPlaneTestAdapter.put_outcome(adapter, :grant_publication, :ambiguous)
    identity = identity()
    state = Session.new(identity.session)

    assert {state, %{"outcome" => "retryable_failure"}} =
             Session.live_target(state, identity, target(operation_id))

    MediaPlaneTestAdapter.put_outcome(adapter, :grant_publication, :confirmed)

    assert {_state, %{"outcome" => "confirmed"}} =
             Session.live_target(state, identity, target(operation_id))

    grants =
      Enum.filter(MediaPlaneTestAdapter.calls(adapter), fn {operation, id, _arguments} ->
        operation == :grant_publication and id == operation_id
      end)

    assert length(grants) == 2
  end

  test "blocking and raising live provider callbacks return within the configured bound" do
    previous_media = Application.get_env(:chalk_sync, :media_plane)
    previous_timeout = Application.get_env(:chalk_sync, :external_operation_adapter_timeout_ms)
    Application.put_env(:chalk_sync, :media_plane, {UnavailableMediaPlane, nil})
    Application.put_env(:chalk_sync, :external_operation_adapter_timeout_ms, 20)

    on_exit(fn ->
      restore_env(:media_plane, previous_media)
      restore_env(:external_operation_adapter_timeout_ms, previous_timeout)
    end)

    identity = identity()
    state = Session.new(identity.session)
    started_at = System.monotonic_time(:millisecond)

    assert {_state, %{"outcome" => "retryable_failure"}} =
             Session.live_target(state, identity, target("camera-blocked-grant-01"))

    disabled = %{target("camera-raising-revoke1") | enabled: false}

    assert {_state, %{"outcome" => "retryable_failure"}} =
             Session.live_target(state, identity, disabled)

    assert {:error, :dependency_unavailable} = Session.register(state, identity, self())
    assert System.monotonic_time(:millisecond) - started_at < 500
  end

  defp target(operation_id) do
    %{
      operation_id: operation_id,
      name: :set_camera_enabled,
      enabled: true
    }
  end

  defp authority do
    %{
      participant_session_id: "00000000-0000-4000-8000-000000000004",
      generation: 1,
      role: "participant",
      capabilities: ["publishVideo"]
    }
  end

  defp identity do
    %Identity{
      session: %SessionKey{
        tenant_id: "00000000-0000-4000-8000-000000000001",
        room_id: "00000000-0000-4000-8000-000000000002",
        session_id: "00000000-0000-4000-8000-000000000003"
      },
      participant_session_id: authority().participant_session_id,
      participant_session_generation: 1,
      protocol_version: 3
    }
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)
end
