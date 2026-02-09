package ai.q9labs.chalk.nativeapp.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ai.q9labs.chalk.meetingkit.ChalkJoinPayload
import ai.q9labs.chalk.nativeapp.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChalkNativeApp(vm: MainViewModel) {
	val state by vm.state.collectAsState()
	val ctx = LocalContext.current

	var accessToken by remember { mutableStateOf("") }
	var rtcToken by remember { mutableStateOf("") }
	var apiUrl by remember { mutableStateOf("") }
	var wsUrl by remember { mutableStateOf("") }
	var roomId by remember { mutableStateOf("") }
	var participantId by remember { mutableStateOf("") }
	var displayName by remember { mutableStateOf("") }
	var showWhiteboard by remember { mutableStateOf(false) }

	Scaffold(
		topBar = { TopAppBar(title = { Text("Chalk Native (Android)") }) },
	) { padding ->
		if (state.connection == "disconnected") {
			Column(
				modifier = Modifier
					.fillMaxSize()
					.padding(padding)
					.padding(16.dp)
					.verticalScroll(rememberScrollState()),
				verticalArrangement = Arrangement.spacedBy(12.dp),
			) {
				Text("State: ${state.connection}")
				if (state.lastError != null) Text("Error: ${state.lastError}")

				OutlinedTextField(apiUrl, { apiUrl = it }, label = { Text("apiUrl (https://... optional)") })
				OutlinedTextField(accessToken, { accessToken = it }, label = { Text("accessToken (Chalk WS)") })
				OutlinedTextField(rtcToken, { rtcToken = it }, label = { Text("rtcToken (RealtimeKit)") })
				OutlinedTextField(wsUrl, { wsUrl = it }, label = { Text("wsUrl (wss://.../ws)") })
				OutlinedTextField(roomId, { roomId = it }, label = { Text("roomId") })
				OutlinedTextField(participantId, { participantId = it }, label = { Text("participantId") })
				OutlinedTextField(displayName, { displayName = it }, label = { Text("displayName") })

				Button(
					onClick = {
						val activity = ctx as? android.app.Activity ?: return@Button
						vm.join(
							activity,
							ChalkJoinPayload(
								apiUrl = apiUrl.ifBlank { null },
								wsUrl = wsUrl,
								accessToken = accessToken,
								rtcToken = rtcToken,
								roomId = roomId,
								participantId = participantId,
								displayName = displayName,
							),
						)
					},
					contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
				) { Text("Join") }
			}
		} else {
			Column(
				modifier = Modifier
					.fillMaxSize()
					.padding(padding)
					.padding(16.dp),
				verticalArrangement = Arrangement.spacedBy(12.dp),
			) {
				Text("State: ${state.connection}")
				if (state.lastError != null) Text("Error: ${state.lastError}")

				Button(
					onClick = {
						showWhiteboard = false
						vm.leave()
					},
					contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
				) { Text("Leave") }

				Button(
					onClick = { showWhiteboard = !showWhiteboard },
					contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
				) { Text(if (showWhiteboard) "Hide Whiteboard" else "Show Whiteboard") }

				Text("Participants (${state.participants.size})")
				for (p in state.participants) {
					Text("- ${p.displayName} (${p.id}) a=${p.audioEnabled} v=${p.videoEnabled}")
				}

				if (showWhiteboard) {
					WhiteboardWebView(
						vm = vm,
						modifier = Modifier
							.fillMaxWidth()
							.weight(1f),
					)
				}
			}
		}
	}
}
