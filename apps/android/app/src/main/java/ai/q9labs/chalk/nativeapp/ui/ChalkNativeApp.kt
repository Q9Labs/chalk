package ai.q9labs.chalk.nativeapp.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.q9labs.chalk.meetingkit.ChalkJoinPayload
import ai.q9labs.chalk.nativeapp.MainViewModel
import ai.q9labs.chalk.nativeapp.ui.screens.LobbyScreen
import ai.q9labs.chalk.nativeapp.ui.screens.MeetingScreen
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkBackground
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkPrimary

@Composable
fun ChalkNativeApp(vm: MainViewModel) {
    val state by vm.state.collectAsState()
    val ctx = LocalContext.current

    // Debug join (until HTTP join flow is wired)
    var displayName by remember { mutableStateOf("Guest") }
    var wsUrl by remember { mutableStateOf("") }
    var roomId by remember { mutableStateOf("") }
    var accessToken by remember { mutableStateOf("") }
    var rtcToken by remember { mutableStateOf("") }
    
    Box(modifier = Modifier.fillMaxSize()) {
        Surface(
            modifier = Modifier.fillMaxSize(),
            color = ChalkBackground
        ) {
            Crossfade(targetState = state.connection) { connectionState ->
                val isConnected = connectionState == "connected"
                if (isConnected) {
                    MeetingScreen(
                        vm = vm,
                        roomTitle = roomId.ifBlank { "Chalk" },
                        participants = state.participants,
                        onLeave = { vm.leave() }
                    )
                } else {
                    LobbyScreen(
                        displayName = displayName,
                        onDisplayNameChange = { displayName = it },
                        wsUrl = wsUrl,
                        onWsUrlChange = { wsUrl = it },
                        roomId = roomId,
                        onRoomIdChange = { roomId = it },
                        accessToken = accessToken,
                        onAccessTokenChange = { accessToken = it },
                        rtcToken = rtcToken,
                        onRtcTokenChange = { rtcToken = it },
                        onJoin = {
                            val activity = ctx as? android.app.Activity ?: return@LobbyScreen
                            vm.join(
                                activity,
                                ChalkJoinPayload(
                                    wsUrl = wsUrl,
                                    accessToken = accessToken,
                                    rtcToken = rtcToken,
                                    roomId = roomId,
                                    participantId = java.util.UUID.randomUUID().toString(),
                                    displayName = displayName
                                )
                            )
                        }
                    )
                }
            }
        }

        // Connecting Overlay
        if (state.connection == "connecting" || state.connection == "ws_connecting" || state.connection == "ws_connected") {
            Box(
                modifier = Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.6f)),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator(color = ChalkPrimary)
                    Spacer(Modifier.height(16.dp))
                    Text("Joining...", color = Color.White)
                }
            }
        }

        // Error Toast
        AnimatedVisibility(
            visible = state.lastError != null,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 60.dp)
        ) {
            Box(
                modifier = Modifier
                    .padding(16.dp)
                    .background(Color.Red, RoundedCornerShape(8.dp))
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Text(
                    text = "Error: ${state.lastError}",
                    color = Color.White,
                    fontSize = 14.sp
                )
            }
        }
    }
}
