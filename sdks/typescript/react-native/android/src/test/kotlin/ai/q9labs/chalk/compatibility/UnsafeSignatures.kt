package ai.q9labs.chalk.compatibility

import android.media.AudioManager
import android.view.View
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

// The original crash: a lazy backing field is safe, but its generated getter is not.
class OriginalListenerModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val communicationListener by lazy { AudioManager.OnCommunicationDeviceChangedListener { } }
  override fun getName() = "OriginalListenerModule"
}

private fun makeListener() = AudioManager.OnCommunicationDeviceChangedListener { }

// No newer Android type appears in this module's source.
class FactoryInferredModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val listener by lazy { makeListener() }
  override fun getName() = "FactoryInferredModule"
}

// Exercise view-manager discovery and a different API-31 listener.
class ModeListenerViewManager : SimpleViewManager<View>() {
  private val listener by lazy { AudioManager.OnModeChangedListener { } }
  override fun getName() = "ModeListenerViewManager"
  override fun createViewInstance(context: ThemedReactContext) = View(context)
}
