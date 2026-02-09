package ai.q9labs.chalk.meetingkit

data class ChalkMeetingState(
	val connection: String = "disconnected",
	val participants: List<ChalkParticipant> = emptyList(),
	val lastError: String? = null,
)

data class ChalkParticipant(
	val id: String,
	val displayName: String,
	val audioEnabled: Boolean = false,
	val videoEnabled: Boolean = false,
	val role: String? = null,
)

