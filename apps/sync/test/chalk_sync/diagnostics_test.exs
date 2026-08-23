defmodule ChalkSync.DiagnosticsTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Diagnostics
  alias ChalkSync.Diagnostics.Buffer
  alias ChalkSync.Stateholder.EpisodeKey

  @buffer __MODULE__.Buffer

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

  defp start_buffer(options \\ []) do
    {:ok, pid} = Buffer.start_link(Keyword.merge([name: @buffer], options))

    on_exit(fn ->
      if Process.alive?(pid), do: GenServer.stop(pid)
    end)

    Application.put_env(:chalk_sync, :episode_diagnostics, %{mode: :localhost, buffer: @buffer})
    pid
  end

  defp episode do
    %EpisodeKey{
      tenant_id: "00000000-0000-4000-8000-000000000001",
      space_id: "00000000-0000-4000-8000-000000000002",
      episode_id: "00000000-0000-4000-8000-000000000003"
    }
  end
end
