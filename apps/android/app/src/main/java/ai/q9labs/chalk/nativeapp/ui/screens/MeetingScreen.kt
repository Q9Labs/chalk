package ai.q9labs.chalk.nativeapp.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.q9labs.chalk.meetingkit.ChalkParticipant
import ai.q9labs.chalk.nativeapp.MainViewModel
import ai.q9labs.chalk.nativeapp.ui.components.ParticipantTile
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkBackground
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkSurface
import ai.q9labs.chalk.nativeapp.ui.WhiteboardWebView

enum class Panel { Chat, Participants, Whiteboard }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeetingScreen(
    vm: MainViewModel,
    roomTitle: String,
    participants: List<ChalkParticipant>,
    onLeave: () -> Unit
) {
    var activePanel by remember { mutableStateOf<Panel?>(null) }
    
    // Dynamic Grid Columns
    val gridColumns = if (participants.size <= 2) 1 else 2
    
    // Bottom Sheet State (using manual overlay for custom height control/animation or Scaffold)
    // For simplicity, we'll use a Box with alignment.

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ChalkBackground)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            // Header
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(roomTitle, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold, color = Color.White)
            }

            // Video Grid
            Box(
                modifier = Modifier
                    .weight(1f) // Takes remaining space, shrinks when panel opens? 
                    // To actually shrink, we need the panel to be in the Column or weight logic.
                    // For now, let's keep it simple: Grid takes all space, Panel overlays.
            ) {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(gridColumns),
                    contentPadding = PaddingValues(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.fillMaxSize()
                ) {
                    items(participants) { p ->
                        ParticipantTile(participant = p)
                    }
                }
            }

            // Controls
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ChalkSurface)
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                ControlButton(icon = Icons.Default.Mic, onClick = {})
                ControlButton(icon = Icons.Default.Videocam, onClick = {})
                
                ControlButton(icon = Icons.Default.PanTool, onClick = {}) // Hand Raise
                ControlButton(icon = Icons.Default.Chat, onClick = { activePanel = if (activePanel == Panel.Chat) null else Panel.Chat })
                ControlButton(icon = Icons.Default.People, onClick = { activePanel = if (activePanel == Panel.Participants) null else Panel.Participants })
                ControlButton(icon = Icons.Default.Edit, onClick = { activePanel = if (activePanel == Panel.Whiteboard) null else Panel.Whiteboard })

                IconButton(
                    onClick = onLeave,
                    modifier = Modifier
                        .background(Color.Red, CircleShape)
                        .padding(8.dp)
                ) {
                    Icon(Icons.Default.CallEnd, contentDescription = "Leave", tint = Color.White)
                }
            }
        }

        // Panel Overlay
        AnimatedVisibility(
            visible = activePanel != null,
            enter = slideInVertically { it },
            exit = slideOutVertically { it },
            modifier = Modifier.align(Alignment.BottomCenter)
        ) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(0.6f),
                shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
                color = ChalkSurface,
                tonalElevation = 8.dp
            ) {
                Column {
                    // Panel Header
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = when (activePanel) {
                                Panel.Chat -> "Chat"
                                Panel.Participants -> "Participants"
                                Panel.Whiteboard -> "Whiteboard"
                                else -> ""
                            },
                            fontSize = 18.sp,
                            fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                            color = Color.White
                        )
                        IconButton(onClick = { activePanel = null }) {
                            Icon(Icons.Default.Close, contentDescription = "Close", tint = Color.Gray)
                        }
                    }
                    Divider(color = Color.Gray.copy(alpha = 0.2f))

                    // Panel Content
                    Box(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                        when (activePanel) {
                            Panel.Chat -> Text("Chat Placeholder", color = Color.White)
                            Panel.Participants -> Text("Participants List", color = Color.White)
                            Panel.Whiteboard -> WhiteboardWebView(vm = vm, modifier = Modifier.fillMaxSize())
                            else -> {}
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun ControlButton(icon: ImageVector, onClick: () -> Unit) {
    IconButton(
        onClick = onClick,
        modifier = Modifier
            .background(Color.White.copy(alpha = 0.1f), CircleShape)
            .padding(4.dp)
    ) {
        Icon(icon, contentDescription = null, tint = Color.White)
    }
}
