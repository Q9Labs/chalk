package ai.q9labs.chalk.meetingkit

import android.content.Context
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

enum class ChalkLogLevel {
	DEBUG,
	INFO,
	ERROR,
}

object ChalkFileLogger {
	private var dir: File? = null
	private val lock = Any()
	private val tsFmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US)

	fun init(context: Context) {
		synchronized(lock) {
			if (dir != null) return
			val d = File(context.filesDir, "chalk-logs")
			d.mkdirs()
			dir = d
		}
	}

	fun log(level: ChalkLogLevel, msg: String, meta: Map<String, String> = emptyMap(), err: Throwable? = null) {
		val d = synchronized(lock) { dir } ?: return
		val ts = tsFmt.format(Date())
		val metaStr = if (meta.isEmpty()) "" else " " + meta.entries
			.sortedBy { it.key }
			.joinToString(" ") { "${it.key}=${escape(it.value)}" }
		val errStr = if (err == null) "" else " err=${escape(err.stackTraceToString())}"
		val line = "$ts level=${level.name.lowercase()}$metaStr msg=${escape(msg)}$errStr\n"

		append(File(d, "chalk.log"), line)
		if (level == ChalkLogLevel.DEBUG) append(File(d, "chalk.debug.log"), line)
		if (level == ChalkLogLevel.ERROR) append(File(d, "chalk.error.log"), line)
	}

	fun files(): List<File> {
		val d = synchronized(lock) { dir } ?: return emptyList()
		return listOf("chalk.log", "chalk.debug.log", "chalk.error.log")
			.map { File(d, it) }
			.filter { it.exists() }
	}

	fun clear() {
		val d = synchronized(lock) { dir } ?: return
		for (name in listOf("chalk.log", "chalk.debug.log", "chalk.error.log")) {
			runCatching { File(d, name).delete() }
		}
	}

	private fun append(file: File, line: String) {
		val maxBytes = 5 * 1024 * 1024
		runCatching {
			if (file.exists() && file.length() > maxBytes) file.delete()
			file.appendText(line)
		}
	}

	private fun escape(s: String) =
		s.replace("\\", "\\\\")
			.replace("\n", "\\n")
			.replace("\r", "\\r")
			.replace("\t", "\\t")
}

