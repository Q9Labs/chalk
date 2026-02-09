package ai.q9labs.chalk.nativeapp.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Colors
val ChalkPrimary = Color(0xFF1BB6A6)
val ChalkBackground = Color(0xFF050505)
val ChalkSurface = Color(0xFF1A1A1A)
val ChalkDestructive = Color(0xFFFF4444) // Approximate Red
val ChalkMuted = Color.Gray.copy(alpha = 0.3f)

private val DarkColorScheme = darkColorScheme(
    primary = ChalkPrimary,
    background = ChalkBackground,
    surface = ChalkSurface,
    error = ChalkDestructive,
    onPrimary = Color.White,
    onBackground = Color.White,
    onSurface = Color.White
)

@Composable
fun ChalkNativeTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}