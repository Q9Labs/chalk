defmodule ChalkSync.Transport.SocketWhiteboardV1.Extensions do
  @moduledoc """
  The optional protocol extensions a whiteboard-v1 client asked for in its hello.

  Each extension is parsed once at the edge into the most specific level the client named, so
  the socket never re-reads the raw extension list.
  """

  @enforce_keys [:presentation, :view, :draw_policy]
  defstruct [:presentation, :view, :draw_policy]

  @type t :: %__MODULE__{
          presentation: :none | :basic | :presenter,
          view: :none | :basic | :origins | :owner,
          draw_policy: boolean()
        }

  @spec none() :: t()
  def none, do: %__MODULE__{presentation: :none, view: :none, draw_policy: false}

  @spec parse([map()]) :: t()
  def parse(extensions) do
    %__MODULE__{
      presentation: presentation(extensions),
      view: view(extensions),
      draw_policy: named?(extensions, "draw_policy_v1")
    }
  end

  @spec presentation?(t()) :: boolean()
  def presentation?(%__MODULE__{presentation: level}), do: level != :none

  @spec presenter?(t()) :: boolean()
  def presenter?(%__MODULE__{presentation: level}), do: level == :presenter

  @spec view?(t()) :: boolean()
  def view?(%__MODULE__{view: level}), do: level != :none

  @spec view_owner?(t()) :: boolean()
  def view_owner?(%__MODULE__{view: level}), do: level == :owner

  defp presentation(extensions) do
    cond do
      Enum.any?(extensions, &(&1["name"] == "presentation_v1" and &1["presenter"] == true)) ->
        :presenter

      named?(extensions, "presentation_v1") ->
        :basic

      true ->
        :none
    end
  end

  defp view(extensions) do
    cond do
      Enum.any?(extensions, &(&1["name"] == "view_v1" and &1["owner"] == true)) -> :owner
      Enum.any?(extensions, &(&1["name"] == "view_v1" and &1["origins"] == true)) -> :origins
      named?(extensions, "view_v1") -> :basic
      true -> :none
    end
  end

  defp named?(extensions, name), do: Enum.any?(extensions, &(&1["name"] == name))
end
