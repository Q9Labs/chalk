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

  @default_timeout_ms 5_000
  # A caller waits this long beyond the adapter budget, so the adapter's own timeout answers first.
  @deadline_slack_ms 1_000

  @doc "The adapter budget a consumer starts with when nothing configures one."
  @spec default_timeout_ms() :: pos_integer()
  def default_timeout_ms, do: @default_timeout_ms

  @doc "How long one provider call may run; the application environment sets it."
  @spec timeout_ms() :: pos_integer()
  def timeout_ms,
    do:
      Application.get_env(
        :chalk_sync,
        :external_operation_adapter_timeout_ms,
        @default_timeout_ms
      )

  @doc "How long a process may wait on a provider call before it gives up on the answer."
  @spec deadline_ms() :: pos_integer()
  def deadline_ms, do: timeout_ms() + @deadline_slack_ms

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
