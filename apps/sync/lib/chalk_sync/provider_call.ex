defmodule ChalkSync.ProviderCall do
  @moduledoc """
  The facts one provider call carries beyond its arguments.

  A plane adapter that wants them implements the optional `with_call/2` callback of
  `ChalkSync.MediaPlane` or `ChalkSync.RecordingPlane`. Callers hand every plane the same
  map and never ask which adapter they hold.
  """

  @type t :: %{
          optional(:headers) => map(),
          optional(:control_revision) => pos_integer() | nil,
          optional(:participant_id) => String.t() | nil,
          optional(:participant_generation) => pos_integer() | nil,
          optional(:payload) => map()
        }

  @type plane :: {module(), term()} | nil

  @spec contextual?(plane()) :: boolean()
  def contextual?({module, _adapter}),
    do: Code.ensure_loaded?(module) and function_exported?(module, :with_call, 2)

  def contextual?(nil), do: false

  @spec attach(plane(), t()) :: plane()
  def attach({module, adapter} = plane, call) do
    if contextual?(plane), do: {module, module.with_call(adapter, call)}, else: plane
  end

  def attach(nil, _call), do: nil
end
