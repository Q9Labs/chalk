package ai.q9labs.chalk.meetingkit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

sealed interface ChalkWsEvent {
	data class RoomSnapshot(val participants: List<WsParticipant>) : ChalkWsEvent
	data class ParticipantJoined(val participant: ChalkParticipant) : ChalkWsEvent
	data class ParticipantLeft(val participantId: String) : ChalkWsEvent
	data class ParticipantUpdated(
		val participantId: String,
		val displayName: String?,
		val audioEnabled: Boolean?,
		val videoEnabled: Boolean?,
	) : ChalkWsEvent

	data class WhiteboardSnapshot(val payload: WsWhiteboardSnapshot) : ChalkWsEvent
	data class WhiteboardData(val payload: WsWhiteboardData) : ChalkWsEvent
	data class WhiteboardCursor(val payload: WsWhiteboardCursor) : ChalkWsEvent
	data class PermissionChanged(val payload: WsPermissionChanged) : ChalkWsEvent
}

@Serializable
private data class WsEnvelope(
	val type: String,
	val payload: JsonElement? = null,
)

@Serializable
private data class WsRoomSnapshot(
	val roomId: String,
	val participants: List<WsParticipant>,
	val isRecording: Boolean,
	val recordingId: String? = null,
	val lastSeq: Double,
)

@Serializable
data class WsParticipant(
	val id: String,
	val displayName: String,
	val role: String? = null,
	val videoEnabled: Boolean? = null,
	val audioEnabled: Boolean? = null,
)

@Serializable
data class WsWhiteboardSnapshot(
	val schemaVersion: Int? = null,
	val roomId: String,
	val sceneId: String? = null,
	val elements: List<JsonElement>,
	val files: Map<String, JsonElement> = emptyMap(),
	val appState: JsonElement,
	val updatedAtMs: Long? = null,
	val lastSeq: Double,
)

@Serializable
data class WsWhiteboardData(
	val schemaVersion: Int? = null,
	val sceneId: String? = null,
	val syncAll: Boolean? = null,
	val participantId: String,
	val displayName: String,
	val elements: List<JsonElement>,
	val files: Map<String, JsonElement>? = null,
	val seq: Double,
	val timestamp: JsonElement? = null,
)

@Serializable
data class WsWhiteboardCursor(
	val participantId: String,
	val displayName: String,
	val x: Double,
	val y: Double,
	val timestamp: JsonElement? = null,
)

@Serializable
data class WsPermissionChanged(
	val participantId: String,
	val feature: String,
	val canDraw: Boolean,
)

class ChalkWsClient {
	private val client = OkHttpClient()
	private var socket: WebSocket? = null

	private val json = Json {
		ignoreUnknownKeys = true
		isLenient = true
	}

	fun connect(
		wsUrl: String,
		accessToken: String,
		onEvent: (ChalkWsEvent) -> Unit,
		onError: (String) -> Unit,
		onState: (String) -> Unit,
	) {
		val req = Request.Builder()
			.url(wsUrl)
			.header("Sec-WebSocket-Protocol", "chalk, token.$accessToken")
			.build()

		onState("ws_connecting")

		socket = client.newWebSocket(
			req,
			object : WebSocketListener() {
				override fun onOpen(webSocket: WebSocket, response: Response) {
					onState("ws_connected")
				}

				override fun onMessage(webSocket: WebSocket, text: String) {
					runCatching {
						val env = json.decodeFromString(WsEnvelope.serializer(), text)
						handle(env, onEvent)
					}.onFailure { onError(it.message ?: "ws decode failed") }
				}

				override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
					onError(t.message ?: "ws failure")
					onState("ws_failed")
				}

				override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
					onState("ws_closed")
				}
			},
		)
	}

	fun sendWhiteboardUpdateV2(sceneId: String, syncAll: Boolean, elementsJson: String, seq: Long? = null) {
		val elements = runCatching { json.decodeFromString(JsonElement.serializer(), elementsJson) }
			.getOrElse { throw IllegalArgumentException("elementsJson must be valid JSON") }
		val payload = buildJsonObject {
			put("schemaVersion", 2)
			put("sceneId", sceneId)
			put("syncAll", syncAll)
			put("elements", elements)
			if (seq != null) put("seq", seq)
		}
		send("whiteboard.update", payload)
	}

	fun sendWhiteboardCursor(x: Double, y: Double) {
		val payload = buildJsonObject {
			put("x", x)
			put("y", y)
		}
		send("whiteboard.cursor", payload)
	}

	fun requestWhiteboardSync() {
		send("whiteboard.sync", buildJsonObject {})
	}

	fun clearWhiteboard() {
		send("whiteboard.clear", buildJsonObject {})
	}

	fun close() {
		socket?.close(1000, "bye")
		socket = null
	}

	private fun send(type: String, payload: JsonElement?) {
		val msg = json.encodeToString(WsEnvelope.serializer(), WsEnvelope(type = type, payload = payload))
		socket?.send(msg)
	}

	private fun handle(env: WsEnvelope, onEvent: (ChalkWsEvent) -> Unit) {
		when (env.type) {
			"room.snapshot", "room.sync" -> {
				val payload = env.payload ?: return
				val snap = json.decodeFromJsonElement(WsRoomSnapshot.serializer(), payload)
				onEvent(ChalkWsEvent.RoomSnapshot(snap.participants))
			}
			"participant.joined" -> {
				val payload = env.payload ?: return
				val p = parseParticipantJoined(payload)
				onEvent(ChalkWsEvent.ParticipantJoined(p))
			}
			"participant.left" -> {
				val obj = env.payload?.jsonObject ?: return
				val id = obj["participantId"]?.jsonPrimitive?.content ?: return
				onEvent(ChalkWsEvent.ParticipantLeft(id))
			}
			"participant.updated" -> {
				val obj = env.payload?.jsonObject ?: return
				val id = obj["participantId"]?.jsonPrimitive?.content ?: return
				val changes = obj["changes"]?.jsonObject ?: return
				onEvent(
					ChalkWsEvent.ParticipantUpdated(
						participantId = id,
						displayName = changes["displayName"]?.jsonPrimitive?.content,
						audioEnabled = changes["audioEnabled"]?.jsonPrimitive?.booleanOrNull,
						videoEnabled = changes["videoEnabled"]?.jsonPrimitive?.booleanOrNull,
					),
				)
			}
			"whiteboard.snapshot" -> {
				val payload = env.payload ?: return
				val snap = json.decodeFromJsonElement(WsWhiteboardSnapshot.serializer(), payload)
				onEvent(ChalkWsEvent.WhiteboardSnapshot(snap))
			}
			"whiteboard.data" -> {
				val payload = env.payload ?: return
				val data = json.decodeFromJsonElement(WsWhiteboardData.serializer(), payload)
				onEvent(ChalkWsEvent.WhiteboardData(data))
			}
			"whiteboard.cursor" -> {
				val payload = env.payload ?: return
				val cur = json.decodeFromJsonElement(WsWhiteboardCursor.serializer(), payload)
				onEvent(ChalkWsEvent.WhiteboardCursor(cur))
			}
			"permission.changed" -> {
				val payload = env.payload ?: return
				val perm = json.decodeFromJsonElement(WsPermissionChanged.serializer(), payload)
				onEvent(ChalkWsEvent.PermissionChanged(perm))
			}
		}
	}

	private fun parseParticipantJoined(payload: JsonElement): ChalkParticipant {
		val obj = payload.jsonObject
		val pObj = (obj["participant"] as? JsonObject) ?: obj
		val id = pObj["id"]?.jsonPrimitive?.content.orEmpty()
		val name = pObj["displayName"]?.jsonPrimitive?.content.orEmpty()
		val role = pObj["role"]?.jsonPrimitive?.content
		val a = pObj["audioEnabled"]?.jsonPrimitive?.booleanOrNull ?: false
		val v = pObj["videoEnabled"]?.jsonPrimitive?.booleanOrNull ?: false
		return ChalkParticipant(id = id, displayName = name, audioEnabled = a, videoEnabled = v, role = role)
	}
}
