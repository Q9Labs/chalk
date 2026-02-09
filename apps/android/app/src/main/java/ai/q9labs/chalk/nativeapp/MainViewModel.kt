package ai.q9labs.chalk.nativeapp

import android.app.Activity
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.q9labs.chalk.meetingkit.ChalkJoinPayload
import ai.q9labs.chalk.meetingkit.ChalkMeetingController
import ai.q9labs.chalk.meetingkit.ChalkPresignDownload
import ai.q9labs.chalk.meetingkit.ChalkPresignUpload
import ai.q9labs.chalk.meetingkit.ChalkWhiteboardUpdateV2
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import java.util.UUID

class MainViewModel(app: android.app.Application) : AndroidViewModel(app) {
	private val controller = ChalkMeetingController(viewModelScope)

	val state: StateFlow<ai.q9labs.chalk.meetingkit.ChalkMeetingState> = controller.state
	val whiteboardEvents: SharedFlow<ai.q9labs.chalk.meetingkit.ChalkWhiteboardEvent> =
		controller.whiteboardEvents

	fun join(activity: Activity, payload: ChalkJoinPayload) {
		viewModelScope.launch { controller.join(activity, payload) }
	}

	fun joinFromEnv(activity: Activity, displayName: String) {
		viewModelScope.launch {
			val env = ChalkEnv.load(getApplication())
			val roomName = "${env.roomPrefix}-${UUID.randomUUID().toString().take(8)}"
			controller.bootstrapAndJoin(
				activity = activity,
				apiUrl = env.apiUrl,
				wsUrl = env.wsUrl,
				apiKey = env.apiKey,
				roomName = roomName,
				displayName = displayName,
			)
		}
	}

	fun leave() {
		viewModelScope.launch { controller.leave() }
	}

	fun sendWhiteboardUpdateV2(update: ChalkWhiteboardUpdateV2) {
		controller.sendWhiteboardUpdateV2(update)
	}

	fun sendWhiteboardCursor(x: Double, y: Double) {
		controller.sendWhiteboardCursor(x, y)
	}

	fun requestWhiteboardSync() {
		controller.requestWhiteboardSync()
	}

	fun clearWhiteboard() {
		controller.clearWhiteboard()
	}

	suspend fun presignWhiteboardUpload(fileId: String, mimeType: String): ChalkPresignUpload =
		controller.presignWhiteboardUpload(fileId, mimeType)

	suspend fun presignWhiteboardDownload(fileId: String): ChalkPresignDownload =
		controller.presignWhiteboardDownload(fileId)
}
