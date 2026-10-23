Code.require_file("apps/sync/lib/chalk_sync/uuid.ex")
owner_source = List.first(System.argv()) || "apps/sync/lib/chalk_sync/whiteboard_v1/view_owner.ex"
Code.require_file(owner_source)
ExUnit.start(autorun: false)

{:ok, _} =
  Supervisor.start_link(
    [
      {Registry, keys: :unique, name: ChalkSync.WhiteboardV1.ViewRegistry},
      {DynamicSupervisor, strategy: :one_for_one, name: ChalkSync.WhiteboardV1.ViewSupervisor}
    ],
    strategy: :one_for_one
  )

Code.require_file("apps/sync/test/chalk_sync/whiteboard_v1/view_owner_test.exs")
result = ExUnit.run()
System.halt(if result.failures == 0, do: 0, else: 1)
