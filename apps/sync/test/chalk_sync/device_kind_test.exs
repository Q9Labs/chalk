defmodule ChalkSync.DeviceKindTest do
  use ExUnit.Case, async: true

  alias ChalkSync.DeviceKind
  alias ChalkSync.Transport.Socket.Frames

  test "parses only the declared kinds" do
    for kind <-
          ~w(iphone ipad android_phone android_tablet android_foldable mac windows linux chromeos) do
      assert DeviceKind.parse(kind) == kind
    end

    for bad <- [nil, "", "toaster", "IPHONE", "ipad ", 7, ["ipad"]] do
      assert DeviceKind.parse(bad) == nil
    end
  end

  test "derives the coarse device type from the kind" do
    for {kind, type} <- [
          {"iphone", "phone"},
          {"android_phone", "phone"},
          {"android_foldable", "phone"},
          {"ipad", "tablet"},
          {"android_tablet", "tablet"},
          {"mac", "computer"},
          {"windows", "computer"},
          {"linux", "computer"},
          {"chromeos", "computer"}
        ] do
      assert DeviceKind.device_type(kind) == type
    end

    assert DeviceKind.device_type(nil) == nil
  end

  test "the kind wins over the user agent, and no kind falls back to the user agent" do
    iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148"
    assert Frames.device_type("ipad", iphone) == "tablet"
    assert Frames.device_type(nil, iphone) == "phone"
  end
end
