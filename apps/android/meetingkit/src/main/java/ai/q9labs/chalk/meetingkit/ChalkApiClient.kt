package ai.q9labs.chalk.meetingkit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class ChalkApiClient(
	private val apiBaseUrl: String,
	private val accessToken: String,
) {
	private val client = OkHttpClient()
	private val json = Json { ignoreUnknownKeys = true }
	private val jsonMedia = "application/json; charset=utf-8".toMediaType()

	@Serializable
	private data class PresignUploadReq(val fileId: String, val mimeType: String)

	@Serializable
	private data class PresignDownloadReq(val fileId: String)

	@Serializable
	internal data class PresignUploadRes(
		@SerialName("uploadUrl") val uploadUrl: String,
		@SerialName("expiresAtMs") val expiresAtMs: Long,
	)

	@Serializable
	internal data class PresignDownloadRes(
		@SerialName("downloadUrl") val downloadUrl: String,
		@SerialName("expiresAtMs") val expiresAtMs: Long,
	)

	fun presignWhiteboardUpload(roomId: String, fileId: String, mimeType: String): PresignUploadRes {
		val body = json.encodeToString(PresignUploadReq(fileId, mimeType)).toRequestBody(jsonMedia)
		val req = Request.Builder()
			.url("$apiBaseUrl/api/v1/rooms/$roomId/whiteboard/files/presign-upload")
			.header("Authorization", "Bearer $accessToken")
			.post(body)
			.build()

		client.newCall(req).execute().use { res ->
			if (!res.isSuccessful) throw IllegalStateException("presign upload failed: ${res.code}")
			val text = res.body?.string() ?: throw IllegalStateException("empty response")
			return json.decodeFromString(PresignUploadRes.serializer(), text)
		}
	}

	fun presignWhiteboardDownload(roomId: String, fileId: String): PresignDownloadRes {
		val body = json.encodeToString(PresignDownloadReq(fileId)).toRequestBody(jsonMedia)
		val req = Request.Builder()
			.url("$apiBaseUrl/api/v1/rooms/$roomId/whiteboard/files/presign-download")
			.header("Authorization", "Bearer $accessToken")
			.post(body)
			.build()

		client.newCall(req).execute().use { res ->
			if (!res.isSuccessful) throw IllegalStateException("presign download failed: ${res.code}")
			val text = res.body?.string() ?: throw IllegalStateException("empty response")
			return json.decodeFromString(PresignDownloadRes.serializer(), text)
		}
	}

	companion object {
		fun inferApiBaseUrl(wsUrl: String): String {
			val trimmed = wsUrl.removeSuffix("/ws")
			return when {
				trimmed.startsWith("wss://") -> "https://" + trimmed.removePrefix("wss://")
				trimmed.startsWith("ws://") -> "http://" + trimmed.removePrefix("ws://")
				else -> trimmed
			}
		}
	}
}

