defmodule ChalkSync.Diagnostics.TransportTest do
  use ExUnit.Case, async: true

  alias ChalkSync.Diagnostics.Transport

  describe "hosted destination validation" do
    test "accepts a public IPv4 address" do
      assert :ok = Transport.validate_resolved_addresses([{104, 21, 75, 71}], :hosted)
    end

    test "accepts mixed public IPv4 and IPv6 addresses" do
      addresses = [
        {172, 67, 216, 152},
        {9_734, 18_176, 12_341, 0, 0, 0, 26_645, 19_271}
      ]

      assert :ok = Transport.validate_resolved_addresses(addresses, :hosted)
    end

    test "rejects the destination when any resolved address is private" do
      addresses = [{104, 21, 75, 71}, {10, 0, 0, 1}]

      assert {:error, :destination_blocked} =
               Transport.validate_resolved_addresses(addresses, :hosted)
    end

    test "rejects an empty DNS result" do
      assert {:error, :destination_blocked} =
               Transport.validate_resolved_addresses([], :hosted)
    end
  end
end
