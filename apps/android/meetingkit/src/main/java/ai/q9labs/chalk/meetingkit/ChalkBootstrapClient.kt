package ai.q9labs.chalk.meetingkit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

internal class ChalkBootstrapClient(
	private val apiUrl: String,
) {
	private val client = OkHttpClient()
	private val json = Json { ignoreUnknownKeys = true; isLenient = true }
	private val jsonMedia = "application/json; charset=utf-8".toMediaType()

	@Serializable
	private data class TokenReq(@SerialName("api_key") val apiKey: String)

	@Serializable
	internal data class TokenRes(
		@SerialName("access_token") val accessToken: String,
		@SerialName("refresh_token") val refreshToken: String,
		@SerialName("token_type") val tokenType: String,
		@SerialName("expires_in") val expiresIn: Int,
	)

	@Serializable
	private data class AddParticipantReq(
		@SerialName("display_name") val displayName: String,
		val role: String? = null,
	)

	@Serializable
	internal data class AddParticipantRes(
		val participant: WsParticipantLike,
		val room: RoomLike,
		@SerialName("access_token") val accessToken: String,
		@SerialName("refresh_token") val refreshToken: String,
		@SerialName("auth_token") val rtcToken: String,
	)

	@Serializable
	internal data class RoomLike(val id: String, val name: String? = null)

	@Serializable
	internal data class WsParticipantLike(val id: String, @SerialName("display_name") val displayName: String)

	fun exchangeApiKey(apiKey: String): TokenRes {
		val body = json.encodeToString(TokenReq(apiKey)).toRequestBody(jsonMedia)
		val req = Request.Builder()
			.url("$apiUrl/api/v1/auth/token")
			.post(body)
			.build()

		client.newCall(req).execute().use { res ->
			if (!res.isSuccessful) throw IllegalStateException("auth/token failed: ${res.code}")
			val text = res.body?.string() ?: throw IllegalStateException("empty response")
			return json.decodeFromString(TokenRes.serializer(), text)
		}
	}

	fun addParticipant(tenantAccessToken: String, roomNameOrId: String, displayName: String): AddParticipantRes {
		val body = json.encodeToString(AddParticipantReq(displayName = displayName)).toRequestBody(jsonMedia)
		val req = Request.Builder()
			.url("$apiUrl/api/v1/rooms/$roomNameOrId/participants")
			.header("Authorization", "Bearer $tenantAccessToken")
			.post(body)
			.build()

		client.newCall(req).execute().use { res ->
			if (!res.isSuccessful) throw IllegalStateException("rooms/$roomNameOrId/participants failed: ${res.code}")
			val text = res.body?.string() ?: throw IllegalStateException("empty response")
			return json.decodeFromString(AddParticipantRes.serializer(), text)
		}
	}
}
