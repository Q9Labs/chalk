defmodule ChalkSync.LifecycleConsumerTest do
  use ExUnit.Case, async: true

  alias ChalkSync.LifecycleConsumer

  test "only drains another page immediately after a full successful poll" do
    assert LifecycleConsumer.poll_delay(32, 0, 32, 100) == 0
    assert LifecycleConsumer.poll_delay(31, 0, 32, 100) == 100
    assert LifecycleConsumer.poll_delay(32, 1, 32, 100) == 100
    assert LifecycleConsumer.poll_delay(32, 32, 32, 100) == 100
  end
end
