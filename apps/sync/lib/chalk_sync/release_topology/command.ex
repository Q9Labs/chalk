defmodule ChalkSync.ReleaseTopology.Command do
  @moduledoc false

  @max_output_bytes 65_536

  def run(%{"argv" => [executable | arguments], "timeout_ms" => timeout_ms}) do
    started_at = monotonic_ms()

    with {:ok, path} <- resolve_executable(executable),
         {:ok, port} <- open(path, arguments) do
      collect(port, started_at, started_at + timeout_ms, [], 0)
    else
      {:error, reason} -> {:error, %{reason: reason, duration_ms: monotonic_ms() - started_at}}
    end
  end

  defp resolve_executable(executable) do
    path =
      if String.contains?(executable, "/") do
        Path.expand(executable)
      else
        System.find_executable(executable)
      end

    if is_binary(path) and File.regular?(path) do
      {:ok, path}
    else
      {:error, "command executable is unavailable"}
    end
  end

  defp open(path, arguments) do
    {:ok,
     Port.open({:spawn_executable, String.to_charlist(path)}, [
       :binary,
       :exit_status,
       :stderr_to_stdout,
       {:args, Enum.map(arguments, &String.to_charlist/1)}
     ])}
  rescue
    ArgumentError -> {:error, "command could not be started"}
  end

  defp collect(port, started_at, deadline, chunks, output_bytes) do
    remaining_ms = max(deadline - monotonic_ms(), 0)

    receive do
      {^port, {:data, output}} ->
        next_size = output_bytes + byte_size(output)

        if next_size > @max_output_bytes do
          close(port)

          {:error,
           %{
             reason: "command output exceeded #{@max_output_bytes} bytes",
             duration_ms: monotonic_ms() - started_at
           }}
        else
          collect(port, started_at, deadline, [output | chunks], next_size)
        end

      {^port, {:exit_status, 0}} ->
        {:ok,
         %{
           exit_code: 0,
           output: chunks |> Enum.reverse() |> IO.iodata_to_binary(),
           duration_ms: monotonic_ms() - started_at
         }}

      {^port, {:exit_status, exit_code}} ->
        {:error,
         %{
           reason: "command exited with status #{exit_code}",
           exit_code: exit_code,
           output: chunks |> Enum.reverse() |> IO.iodata_to_binary(),
           duration_ms: monotonic_ms() - started_at
         }}
    after
      remaining_ms ->
        close(port)
        {:error, %{reason: "command timed out", duration_ms: monotonic_ms() - started_at}}
    end
  end

  defp close(port) do
    if Port.info(port), do: Port.close(port)
  rescue
    ArgumentError -> :ok
  end

  defp monotonic_ms, do: System.monotonic_time(:millisecond)
end
