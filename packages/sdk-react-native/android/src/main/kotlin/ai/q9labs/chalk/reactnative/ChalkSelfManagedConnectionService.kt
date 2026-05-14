package ai.q9labs.chalk.reactnative

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle

class ChalkSelfManagedConnectionService : ConnectionService() {
  override fun onCreateIncomingConnection(connectionManagerPhoneAccount: PhoneAccountHandle, request: ConnectionRequest): Connection {
    return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))
  }

  override fun onCreateIncomingConnectionFailed(connectionManagerPhoneAccount: PhoneAccountHandle, request: ConnectionRequest) {
    // Chalk currently starts telecom calls from app-driven outgoing meeting joins only.
  }

  override fun onCreateOutgoingConnection(connectionManagerPhoneAccount: PhoneAccountHandle, request: ConnectionRequest): Connection {
    val extras = request.extras
    val callId = extras?.getString(ChalkConnectionRegistry.extraCallId)

    val callSpec =
      callId?.let(ChalkConnectionRegistry::findPendingCall)
        ?: return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))

    val connection = ChalkSelfManagedConnection(callSpec)
    ChalkConnectionRegistry.registerConnection(callSpec.callId, connection)
    return connection
  }

  override fun onCreateOutgoingConnectionFailed(connectionManagerPhoneAccount: PhoneAccountHandle, request: ConnectionRequest) {
    val callId = request.extras?.getString(ChalkConnectionRegistry.extraCallId) ?: return
    ChalkConnectionRegistry.disconnect(callId, "error", "Android could not start the telecom call.")
  }
}
