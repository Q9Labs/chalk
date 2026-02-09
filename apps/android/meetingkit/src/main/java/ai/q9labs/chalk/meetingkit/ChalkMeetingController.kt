package ai.q9labs.chalk.meetingkit

import android.app.Activity
import com.cloudflare.realtimekit.RealtimeKitClient
import com.cloudflare.realtimekit.RealtimeKitMeetingBuilder
import com.cloudflare.realtimekit.RtkMeetingRoomEventListener
import com.cloudflare.realtimekit.errors.MeetingError
import com.cloudflare.realtimekit.meta.SocketConnectionState
import com.cloudflare.realtimekit.models.RtkMeetingInfo
import com.cloudflare.realtimekit.participants.RtkParticipantsEventListener
import com.cloudflare.realtimekit.participants.RtkRemoteParticipant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ChalkMeetingController(
	private val scope: CoroutineScope,
) {
	private val _state = MutableStateFlow(ChalkMeetingState())
	val state: StateFlow<ChalkMeetingState> = _state.asStateFlow()

	private val ws = ChalkWsClient()
	private var api: ChalkApiClient? = null
	private var meeting: RealtimeKitClient? = null
	private var roomId: String? = null

	val whiteboardEvents = MutableSharedFlow<ChalkWhiteboardEvent>(extraBufferCapacity = 64)

	suspend fun join(activity: Activity, payload: ChalkJoinPayload) {
		_state.update { it.copy(connection = "connecting", lastError = null) }

		roomId = payload.roomId
		api = ChalkApiClient(
			apiBaseUrl = payload.apiUrl ?: ChalkApiClient.inferApiBaseUrl(payload.wsUrl),
			accessToken = payload.accessToken,
		)

		ws.connect(
			wsUrl = payload.wsUrl,
			accessToken = payload.accessToken,
			onEvent = ::handleWsEvent,
			onError = { err -> _state.update { it.copy(lastError = err, connection = "failed") } },
			onState = { s -> _state.update { it.copy(connection = s) } },
		)

		initRtk(activity, payload.rtcToken)
	}

	suspend fun leave() {
		_state.update { it.copy(connection = "leaving") }
		ws.close()
		api = null
		roomId = null
		meeting?.leaveRoom(onSuccess = {}, onFailure = {})
		meeting?.release(onSuccess = {}, onFailure = {})
		meeting = null
		_state.update { it.copy(connection = "disconnected", participants = emptyList()) }
	}

	fun sendWhiteboardUpdateV2(update: ChalkWhiteboardUpdateV2) {
		ws.sendWhiteboardUpdateV2(
			sceneId = update.sceneId,
			syncAll = update.syncAll,
			elementsJson = update.elementsJson,
			seq = update.seq,
		)
	}

	fun sendWhiteboardCursor(x: Double, y: Double) {
		ws.sendWhiteboardCursor(x, y)
	}

	fun requestWhiteboardSync() {
		ws.requestWhiteboardSync()
	}

	fun clearWhiteboard() {
		ws.clearWhiteboard()
	}

	suspend fun presignWhiteboardUpload(fileId: String, mimeType: String): ChalkPresignUpload {
		val api = api ?: throw IllegalStateException("api not ready")
		val roomId = roomId ?: throw IllegalStateException("roomId missing")
		return withContext(Dispatchers.IO) {
			val res = api.presignWhiteboardUpload(roomId, fileId, mimeType)
			ChalkPresignUpload(uploadUrl = res.uploadUrl, expiresAtMs = res.expiresAtMs)
		}
	}

	suspend fun presignWhiteboardDownload(fileId: String): ChalkPresignDownload {
		val api = api ?: throw IllegalStateException("api not ready")
		val roomId = roomId ?: throw IllegalStateException("roomId missing")
		return withContext(Dispatchers.IO) {
			val res = api.presignWhiteboardDownload(roomId, fileId)
			ChalkPresignDownload(downloadUrl = res.downloadUrl, expiresAtMs = res.expiresAtMs)
		}
	}

	private fun initRtk(activity: Activity, rtcToken: String) {
		val meetingInfo = RtkMeetingInfo(authToken = rtcToken, enableAudio = true, enableVideo = true)

		val rtk = RealtimeKitMeetingBuilder.build(activity)
		meeting = rtk

		rtk.addMeetingRoomEventListener(object : RtkMeetingRoomEventListener {
			override fun onMeetingInitCompleted(meeting: RealtimeKitClient) {}
			override fun onMeetingInitFailed(error: MeetingError) {
				_state.update { it.copy(lastError = error.message, connection = "failed") }
			}

			override fun onMeetingInitStarted() {}

			override fun onMeetingRoomJoinCompleted(meeting: RealtimeKitClient) {
				_state.update { it.copy(connection = "connected") }
			}

			override fun onMeetingRoomJoinFailed(error: MeetingError) {
				_state.update { it.copy(lastError = error.message, connection = "failed") }
			}

			override fun onMeetingRoomJoinStarted() {}

			override fun onMeetingEnded() {
				scope.launch { leave() }
			}

			override fun onSocketConnectionUpdate(newState: SocketConnectionState) {
				// RTK reconnection is independent of Chalk WS; keep as signal for UX only.
				if (newState.reconnected) _state.update { it.copy(connection = "connected") }
			}
		})

		rtk.addParticipantsEventListener(object : RtkParticipantsEventListener {
			override fun onParticipantJoin(participant: RtkRemoteParticipant) {}
			override fun onParticipantLeave(participant: RtkRemoteParticipant) {}
			override fun onActiveParticipantsChanged(active: List<RtkRemoteParticipant>) {}
		})

		rtk.init(meetingInfo, onSuccess = { rtk.joinRoom({}, {}) }, onFailure = { _state.update { it.copy(connection = "failed") } })
	}

	private fun handleWsEvent(event: ChalkWsEvent) {
		when (event) {
			is ChalkWsEvent.RoomSnapshot -> {
				val participants = event.participants.map {
					ChalkParticipant(
						id = it.id,
						displayName = it.displayName,
						audioEnabled = it.audioEnabled ?: false,
						videoEnabled = it.videoEnabled ?: false,
						role = it.role,
					)
				}
				_state.update { it.copy(participants = participants) }
			}
			is ChalkWsEvent.ParticipantJoined -> {
				_state.update { it.copy(participants = (it.participants + event.participant).distinctBy { p -> p.id }) }
			}
			is ChalkWsEvent.ParticipantLeft -> {
				_state.update { it.copy(participants = it.participants.filterNot { p -> p.id == event.participantId }) }
			}
			is ChalkWsEvent.ParticipantUpdated -> {
				_state.update {
					it.copy(
						participants = it.participants.map { p ->
							if (p.id != event.participantId) return@map p
							p.copy(
								displayName = event.displayName ?: p.displayName,
								audioEnabled = event.audioEnabled ?: p.audioEnabled,
								videoEnabled = event.videoEnabled ?: p.videoEnabled,
							)
						},
					)
				}
			}
			is ChalkWsEvent.WhiteboardSnapshot -> whiteboardEvents.tryEmit(ChalkWhiteboardEvent.Snapshot(event.payload))
			is ChalkWsEvent.WhiteboardData -> whiteboardEvents.tryEmit(ChalkWhiteboardEvent.Data(event.payload))
			is ChalkWsEvent.WhiteboardCursor -> whiteboardEvents.tryEmit(ChalkWhiteboardEvent.Cursor(event.payload))
			is ChalkWsEvent.PermissionChanged -> whiteboardEvents.tryEmit(ChalkWhiteboardEvent.Permission(event.payload))
		}
	}
}
