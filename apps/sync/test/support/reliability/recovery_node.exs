# Loaded only by ExternalSyncNode. The parent kills the whole BEAM while a real
# transaction (or committed decision) is parked at an existing fault hook.
{port, ""} = System.fetch_env!("CHALK_RECOVERY_BARRIER_PORT") |> Integer.parse()
target = System.fetch_env!("CHALK_RECOVERY_TARGET")
boundary = System.fetch_env!("CHALK_RECOVERY_BOUNDARY")

park = fn point, context ->
  if Atom.to_string(point) == boundary and
       (context[:command_id] == target or context[:lifecycle_intent_id] == target) do
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 5_000)
    :ok = :gen_tcp.send(socket, JSON.encode!(%{boundary: boundary, target: target}) <> "\n")
    # Bounded even if the parent disappears. No test-only hook enters production.
    :gen_tcp.recv(socket, 0, 15_000)
    System.halt(97)
  end
end

Application.put_env(:chalk_sync, :stateholder_fault_hook, park)
Application.put_env(:chalk_sync, :lifecycle_fault_hook, park)
Code.require_file("scripts/sync-node-local.exs")
