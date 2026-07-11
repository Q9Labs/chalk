package ai.q9labs.chalk.reactnative

import android.net.Uri
import android.telecom.Connection
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.TelecomManager
import android.telecom.VideoProfile
import java.util.concurrent.atomic.AtomicBoolean

internal class ChalkSelfManagedConnection(
  private val callSpec: ChalkConnectionRegistry.ChalkCallSpec,
) : Connection() {
  private val isClosed = AtomicBoolean(false)

  init {
    val uriToken = callSpec.roomId.lowercase().replace("[^a-z0-9._-]".toRegex(), "-")
    setAddress(Uri.fromParts(PhoneAccount.SCHEME_SIP, "$uriToken@chalkmeet.local", null), TelecomManager.PRESENTATION_ALLOWED)
    setCallerDisplayName(callSpec.roomName, TelecomManager.PRESENTATION_ALLOWED)
    setConnectionProperties(PROPERTY_SELF_MANAGED)
    setAudioModeIsVoip(true)
    setInitializing()
    setVideoState(if (callSpec.hasVideo) VideoProfile.STATE_BIDIRECTIONAL else VideoProfile.STATE_AUDIO_ONLY)
  }

  fun markActive() {
    if (isClosed.get()) {
      return
    }

    setInitialized()
    setActive()
  }

  fun markDisconnected(cause: DisconnectCause) {
    finish(cause, null)
  }

  override fun onAbort() {
    finish(DisconnectCause(DisconnectCause.CANCELED), "canceled")
  }

  override fun onDisconnect() {
    finish(DisconnectCause(DisconnectCause.LOCAL), "local")
  }

  override fun onReject() {
    finish(DisconnectCause(DisconnectCause.REJECTED), "rejected")
  }

  private fun finish(cause: DisconnectCause, reason: String?) {
    if (!isClosed.compareAndSet(false, true)) {
      return
    }

    if (reason != null) {
      ChalkConnectionRegistry.emitDisconnectRequested(callSpec.callId, reason)
    }

    ChalkConnectionRegistry.unregisterConnection(callSpec.callId)
    setDisconnected(cause)
    destroy()
  }
}
