package ai.q9labs.chalk.nativeapp.logging

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import ai.q9labs.chalk.meetingkit.ChalkFileLogger

object ChalkLogSharing {
	fun shareLogs(context: Context) {
		val activity = context as? Activity ?: return
		val files = ChalkFileLogger.files()
		if (files.isEmpty()) return

		val uris = files.map {
			FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", it)
		}

		val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
			type = "text/plain"
			putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
			addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
		}

		activity.startActivity(Intent.createChooser(intent, "Share Chalk logs"))
	}

	fun clearLogs() {
		ChalkFileLogger.clear()
	}
}

