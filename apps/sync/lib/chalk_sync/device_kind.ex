defmodule ChalkSync.DeviceKind do
  @moduledoc """
  The device a client declares it is on, a self-reported hint shown to other participants.
  The coarse `device_type` older clients understand derives from it.
  """

  alias ChalkSync.Contract.GeneratedV1

  @kinds GeneratedV1.device_kinds()
  @phones ~w(iphone android_phone android_foldable)
  @tablets ~w(ipad android_tablet)

  @doc "The kind itself, or nil for a value outside the contract."
  def parse(kind) when kind in @kinds, do: kind
  def parse(_kind), do: nil

  def valid?(kind), do: parse(kind) == kind

  @doc "The coarse device a kind belongs to, nil for no kind."
  def device_type(kind) when kind in @phones, do: "phone"
  def device_type(kind) when kind in @tablets, do: "tablet"
  def device_type(kind) when kind in @kinds, do: "computer"
  def device_type(_kind), do: nil
end
