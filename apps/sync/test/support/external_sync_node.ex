defmodule ChalkSync.ExternalSyncNode do
  @moduledoc false

  use GenServer

  @max_log_lines 2_000

  def start_link(options), do: GenServer.start_link(__MODULE__, options)

  def child_spec(options) do
    %{
      id: {__MODULE__, Keyword.fetch!(options, :node_id)},
      start: {__MODULE__, :start_link, [options]},
      restart: :temporary
    }
  end

  def await_ready(node, timeout \\ 20_000),
    do: GenServer.call(node, :await_ready, timeout)

  def logs(node), do: GenServer.call(node, :logs)

  def stop(node, timeout \\ 5_000), do: GenServer.call(node, :stop, timeout)

  @impl GenServer
  def init(options) do
    app_dir = Keyword.fetch!(options, :app_dir)
    database_url = Keyword.fetch!(options, :database_url)
    port = Keyword.fetch!(options, :port)
    node_id = Keyword.fetch!(options, :node_id)
    mix = System.find_executable("mix") || raise "mix executable not found"

    child =
      Port.open({:spawn_executable, String.to_charlist(mix)}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:args,
         Enum.map(["run", "--no-start", "scripts/sync-node-local.exs"], &String.to_charlist/1)},
        {:cd, String.to_charlist(app_dir)},
        {:env,
         [
           {~c"MIX_ENV", ~c"test"},
           {~c"CHALK_SYNC_TEST_DATABASE_URL", String.to_charlist(database_url)},
           {~c"CHALK_SYNC_NODE_PORT", port |> Integer.to_string() |> String.to_charlist()},
           {~c"CHALK_SYNC_NODE_ID", String.to_charlist(node_id)}
         ]},
        {:line, 16_384}
      ])

    {:os_pid, os_pid} = Port.info(child, :os_pid)

    {:ok,
     %{
       child: child,
       os_pid: os_pid,
       beam_pid: nil,
       ready: nil,
       waiters: [],
       logs: :queue.new(),
       log_count: 0,
       exit_status: nil
     }}
  end

  @impl GenServer
  def handle_call(:await_ready, _from, %{ready: ready} = state) when not is_nil(ready),
    do: {:reply, {:ok, ready}, state}

  def handle_call(:await_ready, _from, %{exit_status: status} = state) when not is_nil(status),
    do: {:reply, {:error, {:exited, status, log_lines(state)}}, state}

  def handle_call(:await_ready, from, state),
    do: {:noreply, %{state | waiters: [from | state.waiters]}}

  def handle_call(:logs, _from, state), do: {:reply, log_lines(state), state}

  def handle_call(:stop, _from, state) do
    terminate_os_process(state.beam_pid || state.os_pid)
    {:stop, :normal, :ok, state}
  end

  @impl GenServer
  def handle_info({child, {:data, {:eol, line}}}, %{child: child} = state),
    do: {:noreply, record_line(state, line)}

  def handle_info({child, {:data, {:noeol, line}}}, %{child: child} = state),
    do: {:noreply, record_line(state, line)}

  def handle_info({child, {:exit_status, status}}, %{child: child} = state) do
    Enum.each(state.waiters, &GenServer.reply(&1, {:error, {:exited, status, log_lines(state)}}))
    {:noreply, %{state | exit_status: status, waiters: []}}
  end

  @impl GenServer
  def terminate(_reason, state) do
    terminate_os_process(state.beam_pid || state.os_pid)

    if Port.info(state.child), do: Port.close(state.child)
    :ok
  catch
    :error, :badarg -> :ok
  end

  defp record_line(state, line) do
    logs = :queue.in(line, state.logs)
    count = state.log_count + 1
    {logs, count} = if count > @max_log_lines, do: drop_oldest(logs, count), else: {logs, count}
    state = %{state | logs: logs, log_count: count}

    case JSON.decode(line) do
      {:ok, %{"event" => "sync_node_ready"} = ready} ->
        Enum.each(state.waiters, &GenServer.reply(&1, {:ok, ready}))

        %{
          state
          | ready: ready,
            beam_pid: Map.get(ready, "os_pid"),
            waiters: []
        }

      _other ->
        state
    end
  end

  defp drop_oldest(logs, count) do
    {{:value, _line}, remaining} = :queue.out(logs)
    {remaining, count - 1}
  end

  defp log_lines(state), do: :queue.to_list(state.logs)

  defp terminate_os_process(os_pid) do
    encoded_pid = to_string(os_pid)

    case System.cmd("kill", ["-TERM", encoded_pid], stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {_output, _status} -> :ok
    end

    unless wait_for_exit(encoded_pid, 100) do
      System.cmd("kill", ["-KILL", encoded_pid], stderr_to_stdout: true)
      _exited = wait_for_exit(encoded_pid, 100)
    end
  rescue
    _exception -> :ok
  end

  defp wait_for_exit(_encoded_pid, 0), do: false

  defp wait_for_exit(encoded_pid, attempts) do
    case System.cmd("kill", ["-0", encoded_pid], stderr_to_stdout: true) do
      {_output, 0} ->
        Process.sleep(10)
        wait_for_exit(encoded_pid, attempts - 1)

      {_output, _status} ->
        true
    end
  end
end
