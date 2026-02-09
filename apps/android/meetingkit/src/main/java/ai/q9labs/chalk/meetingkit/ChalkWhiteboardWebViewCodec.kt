package ai.q9labs.chalk.meetingkit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Minimal JSON bridge encoder for the `apps/native/whiteboard-web` host.
 *
 * Native owns WS + HTTP presign. WebView renders Excalidraw and emits user edits/cursors.
 */
object ChalkWhiteboardWebViewCodec {
	fun init(canDraw: Boolean, theme: String? = null): String =
		buildJsonObject {
			put("type", "wb.init")
			put(
				"payload",
				buildJsonObject {
					put("canDraw", canDraw)
					if (theme != null) put("theme", theme)
				},
			)
		}.toString()

	fun fromEvent(event: ChalkWhiteboardEvent): String =
		when (event) {
			is ChalkWhiteboardEvent.Snapshot -> buildJsonObject {
				put("type", "wb.snapshot")
				put(
					"payload",
					buildJsonObject {
						put("sceneId", event.payload.sceneId)
						put("elements", JsonArray(event.payload.elements))
					},
				)
			}.toString()
			is ChalkWhiteboardEvent.Data -> buildJsonObject {
				put("type", "wb.update")
				put(
					"payload",
					buildJsonObject {
						put("sceneId", event.payload.sceneId)
						put("syncAll", event.payload.syncAll)
						put("elements", JsonArray(event.payload.elements))
						put("seq", event.payload.seq)
					},
				)
			}.toString()
			is ChalkWhiteboardEvent.Cursor -> buildJsonObject {
				put("type", "wb.cursor")
				put(
					"payload",
					buildJsonObject {
						put("participantId", event.payload.participantId)
						put("displayName", event.payload.displayName)
						put("x", event.payload.x)
						put("y", event.payload.y)
						val ts = event.payload.timestamp
							?.jsonPrimitive
							?.contentOrNull
						if (ts != null) put("timestampIso", ts)
					},
				)
			}.toString()
			is ChalkWhiteboardEvent.Permission -> init(
				canDraw = event.payload.canDraw,
			)
		}

	fun presignUploadResult(requestId: String, uploadUrl: String? = null, expiresAtMs: Long? = null, error: String? = null): String =
		buildJsonObject {
			put("type", "wb.presignUpload.result")
			put("requestId", requestId)
			put(
				"payload",
				buildJsonObject {
					if (error != null) put("error", error)
					if (uploadUrl != null) put("uploadUrl", uploadUrl)
					if (expiresAtMs != null) put("expiresAtMs", expiresAtMs)
				},
			)
		}.toString()

	fun presignDownloadResult(requestId: String, downloadUrl: String? = null, expiresAtMs: Long? = null, error: String? = null): String =
		buildJsonObject {
			put("type", "wb.presignDownload.result")
			put("requestId", requestId)
			put(
				"payload",
				buildJsonObject {
					if (error != null) put("error", error)
					if (downloadUrl != null) put("downloadUrl", downloadUrl)
					if (expiresAtMs != null) put("expiresAtMs", expiresAtMs)
				},
			)
		}.toString()
}
