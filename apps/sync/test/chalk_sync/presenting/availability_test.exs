defmodule ChalkSync.Presenting.AvailabilityTest do
  use ChalkSync.WhiteboardV1.PostgresRepositoryCase, async: false

  alias ChalkSync.Presenting.Availability

  setup %{connection: db} do
    clear(db)
    on_exit(fn -> clear(db) end)
    start_availability(true)
    :ok
  end

  test "offers presenting under the node default until the API has published", %{connection: db} do
    assert Application.get_env(:chalk_sync, :presenting_default)
    wait_for(true)

    publish_servable(db, false)
    wait_for(false)

    clear(db)
    wait_for(true)
  end

  test "never offers presenting while the API cannot serve it, even with the override on", %{
    connection: db
  } do
    publish_servable(db, false)
    set_override(db, true)
    wait_for(false)

    publish_servable(db, true)
    wait_for(true)
  end

  test "the operator override still turns a servable presenting off", %{connection: db} do
    publish_servable(db, true)
    set_override(db, false)
    wait_for(false)

    set_override(db, true)
    wait_for(true)
  end

  test "once the API has published, it decides even when the node default is off", %{
    connection: db
  } do
    stop_supervised!(Availability)
    start_availability(false)
    wait_for(false)

    publish_servable(db, true)
    wait_for(true)

    set_override(db, false)
    wait_for(false)
  end

  defp start_availability(default) do
    previous = Application.get_env(:chalk_sync, :presenting_default)
    Application.put_env(:chalk_sync, :presenting_default, default)
    on_exit(fn -> Application.put_env(:chalk_sync, :presenting_default, previous) end)
    start_supervised!(Availability)
  end

  defp publish_servable(db, servable) do
    Postgrex.query!(
      db,
      "insert into presenting_api_capability (singleton, servable) values (true, $1) on conflict (singleton) do update set servable = excluded.servable",
      [servable]
    )
  end

  defp set_override(db, enabled) do
    Postgrex.query!(
      db,
      "insert into presenting_settings (singleton, enabled) values (true, $1) on conflict (singleton) do update set enabled = excluded.enabled",
      [enabled]
    )
  end

  defp clear(db) do
    Postgrex.query!(db, "delete from presenting_api_capability", [])
    Postgrex.query!(db, "delete from presenting_settings", [])
  end

  defp wait_for(expected, attempts \\ 40) do
    cond do
      Availability.enabled?() == expected ->
        :ok

      attempts == 0 ->
        flunk("Availability.enabled?() never became #{expected}")

      true ->
        Process.sleep(100)
        wait_for(expected, attempts - 1)
    end
  end
end
