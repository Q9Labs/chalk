package ai.q9labs.chalk.nativeapp

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import ai.q9labs.chalk.nativeapp.ui.ChalkNativeApp
import ai.q9labs.chalk.nativeapp.ui.theme.ChalkNativeTheme

class MainActivity : ComponentActivity() {
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		enableEdgeToEdge()
		setContent {
			ChalkNativeTheme {
				val vm = viewModel<MainViewModel>()
				ChalkNativeApp(vm)
			}
		}
	}
}

