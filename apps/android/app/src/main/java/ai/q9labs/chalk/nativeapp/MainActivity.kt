package ai.q9labs.chalk.nativeapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import ai.q9labs.chalk.meetingkit.ChalkFileLogger
import ai.q9labs.chalk.meetingkit.ChalkLogLevel
import ai.q9labs.chalk.nativeapp.ui.ChalkNativeApp
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkNativeTheme

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		ChalkFileLogger.init(applicationContext)
		ChalkFileLogger.log(ChalkLogLevel.INFO, "app.start")
		enableEdgeToEdge()
		setContent {
			ChalkNativeTheme {
				val vm = viewModel<MainViewModel>()
				ChalkNativeApp(vm)
			}
		}
	}
}
