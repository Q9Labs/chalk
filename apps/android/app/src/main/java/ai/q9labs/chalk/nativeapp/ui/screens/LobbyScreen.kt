package ai.q9labs.chalk.nativeapp.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material.icons.filled.VideocamOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkPrimary
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkSurface

@Composable
fun LobbyScreen(
    displayName: String,
    onDisplayNameChange: (String) -> Unit,
    wsUrl: String,
    onWsUrlChange: (String) -> Unit,
    roomId: String,
    onRoomIdChange: (String) -> Unit,
    accessToken: String,
    onAccessTokenChange: (String) -> Unit,
    rtcToken: String,
    onRtcTokenChange: (String) -> Unit,
    onJoin: () -> Unit,
) {
    var isMicOn by remember { mutableStateOf(true) }
    var isCamOn by remember { mutableStateOf(true) }
    var showAdvanced by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp)
    ) {
        // Header
        Text(
            text = "chalk",
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White
        )

        Spacer(modifier = Modifier.weight(1f))

        // Preview Card
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(300.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(ChalkSurface)
        ) {
            // Camera Placeholder
            if (!isCamOn) {
                Icon(
                    imageVector = Icons.Default.VideocamOff,
                    contentDescription = null,
                    modifier = Modifier.align(Alignment.Center).size(48.dp),
                    tint = Color.Gray
                )
            }

            // Name Label
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(16.dp)
                    .padding(bottom = 60.dp) // Space for controls
            ) {
                Text(
                    text = if (displayName.isBlank()) "Guest" else displayName,
                    modifier = Modifier
                        .background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(16.dp))
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    color = Color.White,
                    fontWeight = FontWeight.Bold
                )
            }

            // Controls
            Row(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                MediaControlButton(
                    isOn = isMicOn,
                    onIcon = Icons.Default.Mic,
                    offIcon = Icons.Default.MicOff,
                    onClick = { isMicOn = !isMicOn }
                )
                MediaControlButton(
                    isOn = isCamOn,
                    onIcon = Icons.Default.Videocam,
                    offIcon = Icons.Default.VideocamOff,
                    onClick = { isCamOn = !isCamOn }
                )
                IconButton(
                    onClick = { },
                    modifier = Modifier
                        .background(ChalkSurface, CircleShape)
                        .padding(4.dp)
                ) {
                    Icon(Icons.Default.MoreHoriz, contentDescription = "More", tint = Color.White)
                }
            }
        }

        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = "Ready to join?",
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
            Text(
                text = "You'll be in a waiting room before entering the call.",
                fontSize = 14.sp,
                color = Color.Gray
            )
        }

        // Inputs
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            OutlinedTextField(
                value = displayName,
                onValueChange = onDisplayNameChange,
                label = { Text("Your Name") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ChalkPrimary,
                    unfocusedBorderColor = ChalkSurface,
                    focusedLabelColor = ChalkPrimary
                )
            )

            TextButton(
                onClick = { showAdvanced = !showAdvanced },
                modifier = Modifier.align(Alignment.Start),
            ) {
                Text(if (showAdvanced) "Hide advanced" else "Show advanced", color = ChalkPrimary)
            }

            AnimatedVisibility(visible = showAdvanced) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(
                        value = wsUrl,
                        onValueChange = onWsUrlChange,
                        label = { Text("wsUrl (wss://.../ws)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ChalkPrimary,
                            unfocusedBorderColor = ChalkSurface,
                            focusedLabelColor = ChalkPrimary
                        ),
                    )
                    OutlinedTextField(
                        value = roomId,
                        onValueChange = onRoomIdChange,
                        label = { Text("roomId") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ChalkPrimary,
                            unfocusedBorderColor = ChalkSurface,
                            focusedLabelColor = ChalkPrimary
                        ),
                    )
                    OutlinedTextField(
                        value = accessToken,
                        onValueChange = onAccessTokenChange,
                        label = { Text("accessToken (Chalk WS)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ChalkPrimary,
                            unfocusedBorderColor = ChalkSurface,
                            focusedLabelColor = ChalkPrimary
                        ),
                    )
                    OutlinedTextField(
                        value = rtcToken,
                        onValueChange = onRtcTokenChange,
                        label = { Text("rtcToken (RealtimeKit)") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = ChalkPrimary,
                            unfocusedBorderColor = ChalkSurface,
                            focusedLabelColor = ChalkPrimary
                        ),
                    )
                }
            }

            Button(
                onClick = onJoin,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
                enabled = displayName.isNotBlank() && wsUrl.isNotBlank() && roomId.isNotBlank() && accessToken.isNotBlank() && rtcToken.isNotBlank(),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ChalkPrimary,
                    disabledContainerColor = Color.Gray.copy(alpha = 0.3f)
                ),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Ask to join", fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
        }

        Spacer(modifier = Modifier.weight(1f))
    }
}

@Composable
fun MediaControlButton(
    isOn: Boolean,
    onIcon: androidx.compose.ui.graphics.vector.ImageVector,
    offIcon: androidx.compose.ui.graphics.vector.ImageVector,
    onClick: () -> Unit
) {
    IconButton(
        onClick = onClick,
        modifier = Modifier
            .background(if (isOn) ChalkSurface else Color.Red, CircleShape)
            .padding(4.dp)
    ) {
        Icon(
            imageVector = if (isOn) onIcon else offIcon,
            contentDescription = null,
            tint = Color.White
        )
    }
}
