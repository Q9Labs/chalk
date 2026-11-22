defmodule ChalkSync.ObsTest do
  use ExUnit.Case, async: false

  alias ChalkSync.Obs
  alias ChalkSync.Obs.{Flags, Ids, Registry, Violation}

  @vectors "../../../../observability/registry/vectors.json"
           |> Path.expand(__DIR__)
           |> File.read!()
           |> JSON.decode!()
  @episode "0f8fad5b-d9cb-469f-a165-70867728950e"

  setup do
    test = self()
    handler = "obs-test-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler,
      [:chalk_sync, :obs, :record],
      fn _event, _measurements, record, _config -> send(test, {:record, record}) end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler) end)
  end

  defp record! do
    assert_receive {:record, record}
    record
  end

  # The vectors are JSON; compare through the same JSON shape so the Elixir maps match the TypeScript output.
  defp as_json(value), do: value |> JSON.encode!() |> JSON.decode!()

  describe "vectors shared with the TypeScript and Go kernels" do
    test "format_handle" do
      for vector <- @vectors["format"] do
        got = Ids.format_handle(vector["kind"], vector["id"], vector["scope"])

        if vector["error"],
          do: assert(got == :error, inspect(vector)),
          else: assert(got == {:ok, vector["expect"]}, inspect(vector))
      end
    end

    test "parse_handle" do
      for vector <- @vectors["parse"] do
        case {Ids.parse_handle(vector["text"]), vector["error"]} do
          {{:error, code}, expected} when is_binary(expected) ->
            assert code == expected, inspect(vector)

          {{:ok, handle}, nil} ->
            assert as_json(handle) == vector["expect"], inspect(vector)

          {got, _expected} ->
            flunk("#{inspect(vector)} parsed as #{inspect(got)}")
        end
      end
    end

    test "resolve_handle" do
      for vector <- @vectors["resolve"] do
        {:ok, handle} = Ids.parse_handle(vector["text"])

        targets =
          for target <- vector["candidates"],
              do: %{
                kind: target["kind"],
                id: target["id"],
                legacy_hash: target["legacyHash"] || ""
              }

        assert as_json(Ids.resolve_handle(handle, targets)) == vector["expect"], inspect(vector)
      end
    end

    test "diagnostic_code" do
      for vector <- @vectors["diagnostic_code"],
          do: assert(Ids.diagnostic_code(vector["id"]) == {:ok, vector["expect"]})
    end

    test "flags_hash" do
      for vector <- @vectors["flags_hash"] do
        if vector["error"] do
          assert {:error, _problem} = Flags.hash(vector["flags"])
        else
          assert Flags.canonical(vector["flags"]) == {:ok, vector["canonical"]}
          assert Flags.hash(vector["flags"]) == {:ok, vector["expect"]}
        end
      end
    end

    test "a legacy participant hash resolves to its participant" do
      {:ok, handle} = Ids.parse_handle(Ids.legacy_hash(@episode))

      assert %{status: "unique", match: %{id: @episode}} =
               Ids.resolve_handle(handle, [
                 %{kind: "participant", id: @episode, legacy_hash: Ids.legacy_hash(@episode)}
               ])
    end
  end

  describe "op" do
    test "records exactly one terminal outcome and returns the result" do
      cases = [
        {fn -> {:ok, 1} end, [], "ok", nil},
        {fn -> {:error, :disk} end, [], "error", "unclassified"},
        {fn -> :busy end, [classify: fn :busy -> {:expected, "selftest.busy"} end], "expected",
         "selftest.busy"},
        {fn -> :broken end, [classify: fn :broken -> {:error, "selftest.broken"} end], "error",
         "selftest.broken"}
      ]

      for {fun, options, outcome, code} <- cases do
        assert Obs.op("selftest.work", %{item_count: 3, episode_id: @episode}, fun, options) ==
                 fun.()

        record = record!()

        assert %{
                 "kind" => "op",
                 "name" => "selftest.work",
                 "outcome" => ^outcome,
                 "item_count" => 3,
                 "episode_id" => @episode
               } = record

        assert record["reason_code"] == code
        assert is_integer(record["duration_ms"]) and is_binary(record["op_id"])

        assert %{
                 "module" => "sync",
                 "env" => "test",
                 "clock_state" => "server",
                 "schema_ver" => schema_ver
               } = record

        assert schema_ver == Registry.schema_ver()
        refute_received {:record, _extra}
      end
    end

    test "a raise is recorded as error(unclassified) and then continues" do
      assert_raise RuntimeError, "boom", fn ->
        Obs.op("selftest.work", %{}, fn -> raise "boom" end)
      end

      assert %{"outcome" => "error", "reason_code" => "unclassified"} = record!()
    end

    test "links child ops and takes fields learned while it ran" do
      Obs.op("selftest.work", %{}, fn ->
        Obs.set(item_count: 7)
        Obs.op("selftest.work", %{}, fn -> :ok end)
      end)

      child = record!()
      outer = record!()
      assert child["parent_op_id"] == outer["op_id"]
      assert outer["item_count"] == 7
      assert child["seq"] < outer["seq"]
    end
  end

  describe "closed mode" do
    test "rejects what the registry does not declare" do
      checks = [
        {"unknown event selftest.nope", fn -> Obs.fact("selftest.nope", %{}) end},
        {"is declared as op, not fact", fn -> Obs.fact("selftest.work", %{}) end},
        {"required field note_kind is missing", fn -> Obs.fact("selftest.note", %{}) end},
        {"field note_kind has \"b\"", fn -> Obs.fact("selftest.note", %{note_kind: "b"}) end},
        {"field item_count is not declared",
         fn -> Obs.fact("selftest.note", %{note_kind: "a", item_count: 1}) end},
        {"field mystery is not in the registry",
         fn -> Obs.fact("selftest.note", %{note_kind: "a", mystery: 1}) end},
        {"reason selftest.broken is error, not expected",
         fn ->
           Obs.op("selftest.work", %{}, fn -> :x end,
             classify: fn _ -> {:expected, "selftest.broken"} end
           )
         end},
        {"open -> locked is not a declared edge",
         fn -> Obs.transition("selftest.door", "open", "locked", "lock") end},
        {"unknown trigger kick",
         fn -> Obs.transition("selftest.door", "closed", "open", "kick") end},
        {"unknown decision maybe", fn -> Obs.decision("selftest.admit", "maybe", %{}) end}
      ]

      for {message, call} <- checks do
        error = assert_raise Violation, call
        assert Exception.message(error) =~ message
      end
    end
  end

  test "open mode counts a violation and still emits the record" do
    previous = Application.get_env(:chalk_sync, Obs)
    Application.put_env(:chalk_sync, Obs, Keyword.put(previous, :mode, :open))
    on_exit(fn -> Application.put_env(:chalk_sync, Obs, previous) end)
    %{violations: before} = Obs.stats()
    Obs.fact("selftest.note", %{note_kind: "b"})
    assert %{"note_kind" => "b"} = record!()
    assert Obs.stats().violations == before + 1
  end

  # A release loads every module before :crypto exists, so an @on_load that needs it kills the kernel
  # (on_load_function_failed). Mix has already started :crypto, so only the source can show that.
  test "no module runs code while it loads" do
    lib = Path.expand("../../lib", __DIR__)

    offenders =
      lib
      |> Path.join("**/*.ex")
      |> Path.wildcard()
      |> Enum.filter(&(&1 |> File.read!() |> String.contains?("@on_load")))

    assert offenders == []
  end

  test "init keeps the counters it already made" do
    previous = Application.get_env(:chalk_sync, Obs)
    Application.put_env(:chalk_sync, Obs, Keyword.put(previous, :mode, :open))
    on_exit(fn -> Application.put_env(:chalk_sync, Obs, previous) end)
    Obs.fact("selftest.note", %{note_kind: "b"})
    %{violations: counted} = Obs.stats()
    assert counted > 0

    assert :ok = Obs.init()
    assert %{violations: ^counted} = Obs.stats()
  end

  test "transition, decision, surface and flags" do
    Obs.transition("selftest.door", "closed", "open", "push", %{}, reason: "selftest.busy")

    assert %{
             "kind" => "transition",
             "from_state" => "closed",
             "to_state" => "open",
             "reason_code" => "selftest.busy"
           } = record!()

    decision_id = Obs.decision("selftest.admit", "refused", %{}, "selftest.busy")
    assert %{"decision" => "refused", "decision_id" => ^decision_id} = record!()

    dismiss = Obs.surface("selftest.banner", %{banner_kind: "info"})
    dismiss.()
    dismiss.()
    assert %{"surface_state" => "shown"} = record!()
    assert %{"surface_state" => "dismissed", "shown_ms" => shown_ms} = record!()
    assert is_integer(shown_ms)
    refute_received {:record, _second_dismissal}

    flags_key = {Obs, :flags_hash}
    previous_hash = :persistent_term.get(flags_key, nil)

    on_exit(fn ->
      if previous_hash,
        do: :persistent_term.put(flags_key, previous_hash),
        else: :persistent_term.erase(flags_key)
    end)

    Obs.set_flags(%{"recording" => "on", "max_participants" => 50, "media.kill_switch" => false})
    assert %{"name" => "obs.flags_snapshot", "flags_hash" => "8c3f49d344bb8e59"} = record!()
    Obs.fact("selftest.note", %{note_kind: "a"})
    assert %{"flags_hash" => "8c3f49d344bb8e59"} = record!()
  end
end
