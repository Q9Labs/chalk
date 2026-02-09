package ai.q9labs.chalk.meetingkit


sealed interface ChalkWhiteboardEvent {
	data class Snapshot(val payload: WsWhiteboardSnapshot) : ChalkWhiteboardEvent
	data class Data(val payload: WsWhiteboardData) : ChalkWhiteboardEvent
	data class Cursor(val payload: WsWhiteboardCursor) : ChalkWhiteboardEvent
	data class Permission(val payload: WsPermissionChanged) : ChalkWhiteboardEvent
}

data class ChalkPresignUpload(val uploadUrl: String, val expiresAtMs: Long)
data class ChalkPresignDownload(val downloadUrl: String, val expiresAtMs: Long)

data class ChalkWhiteboardUpdateV2(
	val sceneId: String,
	val syncAll: Boolean,
	/** JSON array string (Excalidraw elements) */
	val elementsJson: String,
	val seq: Long? = null,
)
