package ai.q9labs.chalk.meetingkit

import kotlinx.serialization.Serializable

@Serializable
data class ChalkJoinPayload(
	val apiUrl: String? = null,
	val wsUrl: String,
	val accessToken: String,
	val refreshToken: String? = null,
	val rtcToken: String,
	val roomId: String,
	val participantId: String,
	val displayName: String,
)
