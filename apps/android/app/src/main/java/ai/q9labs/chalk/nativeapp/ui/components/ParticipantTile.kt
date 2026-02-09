package ai.q9labs.chalk.nativeapp.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.q9labs.chalk.meetingkit.ChalkParticipant
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkSurface

@Composable
fun ParticipantTile(participant: ChalkParticipant) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .clip(RoundedCornerShape(12.dp))
            .background(ChalkSurface)
    ) {
        // Video Placeholder (or Avatar)
        if (!participant.videoEnabled) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = getInitials(participant.displayName),
                    fontSize = 32.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color.Gray
                )
            }
        } else {
            // Render video surface here
        }

        // Name Tag
        Row(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(8.dp)
                .background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(4.dp))
                .padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(
                text = participant.displayName,
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
            
            if (!participant.audioEnabled) {
                Icon(
                    imageVector = Icons.Default.MicOff,
                    contentDescription = "Muted",
                    tint = Color.Red,
                    modifier = Modifier.size(12.dp)
                )
            }
        }
    }
}

fun getInitials(name: String): String {
    val parts = name.split(" ").filter { it.isNotEmpty() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(1).uppercase()
        else -> "${parts[0].first()}${parts.last().first()}".uppercase()
    }
}
