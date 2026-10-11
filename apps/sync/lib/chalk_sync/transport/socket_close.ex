defmodule ChalkSync.Transport.SocketClose do
  @moduledoc "Bounded socket close details; peer close codes and text are not available."

  def attributes(reason, chosen) do
    attributes = chosen || %{reason: transport_reason(reason)}

    kind =
      case attributes.reason do
        :normal -> :normal
        :client_closed -> :normal
        :server_shutdown -> :drain
        _reason -> :abnormal
      end

    Map.put(attributes, :close_kind, kind)
  end

  defp transport_reason(:normal), do: :normal
  defp transport_reason(:remote), do: :client_closed
  defp transport_reason(:timeout), do: :timeout
  defp transport_reason(:shutdown), do: :server_shutdown
  defp transport_reason({:shutdown, _detail}), do: :server_shutdown
  defp transport_reason(_reason), do: :transport_error
end
