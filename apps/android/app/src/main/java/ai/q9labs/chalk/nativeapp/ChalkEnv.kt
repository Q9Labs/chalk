package ai.q9labs.chalk.nativeapp

import android.app.Application
import java.io.BufferedReader

data class ChalkEnv(
	val apiUrl: String,
	val wsUrl: String,
	val apiKey: String,
	val roomPrefix: String = "native",
) {
	companion object {
		fun load(app: Application): ChalkEnv {
			val map = readEnv(app, "chalk.env")
			val apiUrl = map["CHALK_API_URL"]?.trim().orEmpty()
			val wsUrl = map["CHALK_WS_URL"]?.trim().orEmpty()
			val apiKey = map["CHALK_API_KEY"]?.trim().orEmpty()
			val roomPrefix = map["CHALK_ROOM_PREFIX"]?.trim().orEmpty().ifBlank { "native" }

			if (apiUrl.isBlank()) throw IllegalStateException("Missing CHALK_API_URL in assets/chalk.env")
			if (wsUrl.isBlank()) throw IllegalStateException("Missing CHALK_WS_URL in assets/chalk.env")
			if (apiKey.isBlank()) throw IllegalStateException("Missing CHALK_API_KEY in assets/chalk.env")
			return ChalkEnv(apiUrl = apiUrl, wsUrl = wsUrl, apiKey = apiKey, roomPrefix = roomPrefix)
		}

		private fun readEnv(app: Application, assetName: String): Map<String, String> {
			val out = mutableMapOf<String, String>()
			app.assets.open(assetName).use { input ->
				BufferedReader(input.reader()).useLines { lines ->
					for (raw in lines) {
						val line = raw.trim()
						if (line.isBlank()) continue
						if (line.startsWith("#")) continue
						val idx = line.indexOf('=')
						if (idx <= 0) continue
						val key = line.substring(0, idx).trim()
						val value = line.substring(idx + 1).trim()
						out[key] = value
					}
				}
			}
			return out
		}
	}
}

