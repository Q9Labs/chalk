package ai.q9labs.chalk.reactnative

import android.media.AudioManager
import android.os.Build
import androidx.annotation.RequiresApi
import java.util.concurrent.Executor

@RequiresApi(Build.VERSION_CODES.S)
internal class CommunicationDeviceListener(
  private val audioManager: AudioManager,
  executor: Executor,
  onChanged: () -> Unit,
) : AutoCloseable {
  private val listener = AudioManager.OnCommunicationDeviceChangedListener { onChanged() }

  init {
    audioManager.addOnCommunicationDeviceChangedListener(executor, listener)
  }

  override fun close() {
    audioManager.removeOnCommunicationDeviceChangedListener(listener)
  }
}
