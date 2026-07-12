database_url =
  System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
    raise "CHALK_SYNC_TEST_DATABASE_URL is required"

port =
  System.fetch_env!("CHALK_SYNC_NODE_PORT")
  |> Integer.parse()
  |> case do
    {value, ""} when value > 0 and value <= 65_535 -> value
    _ -> raise "CHALK_SYNC_NODE_PORT must be a valid TCP port"
  end

node_id = System.get_env("CHALK_SYNC_NODE_ID", "local-node")

Application.put_env(:chalk_sync, :stateholder, ChalkSync.Stateholder.Postgres)
Application.put_env(:chalk_sync, :database_url, database_url)
Application.put_env(:chalk_sync, :database_pool_size, 8)
Application.put_env(:chalk_sync, :port, port)
Application.put_env(:chalk_sync, :dev_tools, false)
Application.put_env(:chalk_sync, :enable_v1, false)
Application.put_env(:chalk_sync, :enforce_production_boot_checks, false)
Application.put_env(:chalk_sync, :require_production_auth, false)
Application.put_env(:chalk_sync, :require_synchronous_standby, false)

{:ok, _started} = Application.ensure_all_started(:chalk_sync)

IO.puts(
  JSON.encode!(%{
    "event" => "sync_node_ready",
    "node_id" => node_id,
    "port" => port,
    "os_pid" => System.pid()
  })
)

Process.sleep(:infinity)
