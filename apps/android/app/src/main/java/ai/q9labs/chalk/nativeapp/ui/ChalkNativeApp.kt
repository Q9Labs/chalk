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
import ai.q9labs.chalk.meetingkit.ChalkFileLogger
import ai.q9labs.chalk.meetingkit.ChalkLogLevel
import ai.q9labs.chalk.nativeapp.MainViewModel
import ai.q9labs.chalk.nativeapp.logging.ChalkLogSharing
import ai.q9labs.chalk.nativeapp.ui.screens.LobbyScreen
import ai.q9labs.chalk.nativeapp.ui.screens.MeetingScreen
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkBackground
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkPrimary

@Composable
fun ChalkNativeApp(vm: MainViewModel) {
    val state by vm.state.collectAsState()
    val ctx = LocalContext.current

    // Dev bootstrap join uses `apps/native/.env` copied into assets as `chalk.env`
    var displayName by remember { mutableStateOf("Guest") }
    var showConfigHint by remember { mutableStateOf(false) }
    
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
                        roomTitle = "Chalk",
                        participants = state.participants,
                        onLeave = { vm.leave() }
                    )
                } else {
                    LobbyScreen(
                        displayName = displayName,
                        onDisplayNameChange = { displayName = it },
                        onJoin = {
                            val activity = ctx as? android.app.Activity ?: return@LobbyScreen
                            runCatching { vm.joinFromEnv(activity, displayName) }
                                .onFailure {
                                    ChalkFileLogger.log(ChalkLogLevel.ERROR, "bootstrap.join_failed", meta = mapOf("err" to (it.message ?: "unknown")), err = it)
                                    showConfigHint = true
                                }
                        },
                        onShareLogs = { ChalkLogSharing.shareLogs(ctx) },
                        onClearLogs = { ChalkLogSharing.clearLogs() },
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

        AnimatedVisibility(
            visible = showConfigHint,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
        ) {
            Box(
                modifier = Modifier
                    .padding(16.dp)
                    .background(Color.Black.copy(alpha = 0.8f), RoundedCornerShape(12.dp))
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text(
                    text = "Missing env. Create `apps/native/.env` (see `apps/native/.env.example`).",
                    color = Color.White,
                    fontSize = 12.sp,
                )
            }
        }
    }
}
