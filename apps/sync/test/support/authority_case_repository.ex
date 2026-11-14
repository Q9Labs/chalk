defmodule ChalkSync.WhiteboardV1.AuthorityCase.Repository do
  @moduledoc "Stub repository the socket tests install through app env."

  # Reads run in the Episode's poller, so the test's answer and its read log live in app env.
  # The answer is taken before the read is reported, so a change after the report is a commit
  # during an in-flight read.
  def episode_access(episode) do
    access = Application.get_env(:chalk_sync, :authority_test_access)

    if test = Application.get_env(:chalk_sync, :authority_test),
      do: send(test, {:read, episode})

    Process.sleep(Application.get_env(:chalk_sync, :authority_test_read_delay_ms, 0))
    access
  end
end
