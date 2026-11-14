defmodule ChalkSync.Observability.Support do
  @moduledoc """
  Failure isolation and config lookup shared by the observability modules.
  """

  def config do
    :chalk_sync
    |> Application.get_env(:observability, [])
    |> Map.new()
  end

  def safely(fun, fallback) do
    fun.()
  rescue
    _exception -> fallback
  catch
    :exit, _reason -> fallback
  end
end
