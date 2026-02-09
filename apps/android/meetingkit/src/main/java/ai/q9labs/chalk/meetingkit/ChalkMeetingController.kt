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
	private var refreshToken: String? = null
	private var meeting: RealtimeKitClient? = null
	private var roomId: String? = null
	private val log = ChalkFileLogger

	val whiteboardEvents = MutableSharedFlow<ChalkWhiteboardEvent>(extraBufferCapacity = 64)

	suspend fun join(activity: Activity, payload: ChalkJoinPayload) {
		_state.update { it.copy(connection = "connecting", lastError = null) }
		log.log(ChalkLogLevel.INFO, "join.start", meta = mapOf("ws" to payload.wsUrl))

		roomId = payload.roomId
		refreshToken = payload.refreshToken
		api = ChalkApiClient(
			apiBaseUrl = payload.apiUrl ?: ChalkApiClient.inferApiBaseUrl(payload.wsUrl),
			accessToken = payload.accessToken,
		)

		ws.connect(
			wsUrl = payload.wsUrl,
			accessToken = payload.accessToken,
			onEvent = ::handleWsEvent,
			onError = { err ->
				log.log(ChalkLogLevel.ERROR, "ws.error", meta = mapOf("err" to err))
				_state.update { it.copy(lastError = err, connection = "failed") }
			},
			onState = { s ->
				log.log(ChalkLogLevel.DEBUG, "ws.state", meta = mapOf("state" to s))
				_state.update { it.copy(connection = s) }
			},
		)

		initRtk(activity, payload.rtcToken)
	}

	suspend fun bootstrapAndJoin(
		activity: Activity,
		apiUrl: String,
		wsUrl: String,
		apiKey: String,
		roomName: String,
		displayName: String,
	) {
		_state.update { it.copy(connection = "connecting", lastError = null) }
		log.log(ChalkLogLevel.INFO, "bootstrap.start", meta = mapOf("apiUrl" to apiUrl, "wsUrl" to wsUrl, "roomName" to roomName))

		val bootstrap = ChalkBootstrapClient(apiUrl)
		val tenant = withContext(Dispatchers.IO) { bootstrap.exchangeApiKey(apiKey) }
		val joined = withContext(Dispatchers.IO) { bootstrap.addParticipant(tenant.accessToken, roomName, displayName) }

		join(
			activity,
			ChalkJoinPayload(
				apiUrl = apiUrl,
				wsUrl = wsUrl,
				accessToken = joined.accessToken,
				refreshToken = joined.refreshToken,
				rtcToken = joined.rtcToken,
				roomId = joined.room.id,
				participantId = joined.participant.id,
				displayName = displayName,
			),
		)
	}

	suspend fun leave() {
		log.log(ChalkLogLevel.INFO, "leave.start")
		_state.update { it.copy(connection = "leaving") }
		ws.close()
		api = null
		roomId = null
		refreshToken = null
		meeting?.leaveRoom(onSuccess = {}, onFailure = {})
		meeting?.release(onSuccess = {}, onFailure = {})
		meeting = null
		_state.update { it.copy(connection = "disconnected", participants = emptyList()) }
		log.log(ChalkLogLevel.INFO, "leave.done")
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
				log.log(ChalkLogLevel.ERROR, "rtk.init_failed", meta = mapOf("err" to (error.message ?: "unknown")))
				_state.update { it.copy(lastError = error.message, connection = "failed") }
			}

			override fun onMeetingInitStarted() {}

			override fun onMeetingRoomJoinCompleted(meeting: RealtimeKitClient) {
				_state.update { it.copy(connection = "connected") }
				log.log(ChalkLogLevel.INFO, "rtk.join_ok")
			}

			override fun onMeetingRoomJoinFailed(error: MeetingError) {
				log.log(ChalkLogLevel.ERROR, "rtk.join_failed", meta = mapOf("err" to (error.message ?: "unknown")))
				_state.update { it.copy(lastError = error.message, connection = "failed") }
			}

			override fun onMeetingRoomJoinStarted() {}

			override fun onMeetingEnded() {
				log.log(ChalkLogLevel.INFO, "rtk.meeting_ended")
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

		rtk.init(
			meetingInfo,
			onSuccess = { rtk.joinRoom({}, {}) },
			onFailure = {
				log.log(ChalkLogLevel.ERROR, "rtk.init_failed", meta = mapOf("err" to "init failure callback"))
				_state.update { it.copy(connection = "failed") }
			},
		)
	}

	private fun handleWsEvent(event: ChalkWsEvent) {
		when (event) {
			is ChalkWsEvent.RoomSnapshot -> {
				log.log(ChalkLogLevel.DEBUG, "ws.room_snapshot", meta = mapOf("participants" to event.participants.size.toString()))
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
				log.log(ChalkLogLevel.DEBUG, "ws.participant_joined", meta = mapOf("participantId" to event.participant.id))
				_state.update { it.copy(participants = (it.participants + event.participant).distinctBy { p -> p.id }) }
			}
			is ChalkWsEvent.ParticipantLeft -> {
				log.log(ChalkLogLevel.DEBUG, "ws.participant_left", meta = mapOf("participantId" to event.participantId))
				_state.update { it.copy(participants = it.participants.filterNot { p -> p.id == event.participantId }) }
			}
			is ChalkWsEvent.ParticipantUpdated -> {
				log.log(ChalkLogLevel.DEBUG, "ws.participant_updated", meta = mapOf("participantId" to event.participantId))
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
