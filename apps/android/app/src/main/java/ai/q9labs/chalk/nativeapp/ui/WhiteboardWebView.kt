package ai.q9labs.chalk.nativeapp.ui

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import ai.q9labs.chalk.meetingkit.ChalkPresignDownload
import ai.q9labs.chalk.meetingkit.ChalkPresignUpload
import ai.q9labs.chalk.meetingkit.ChalkWhiteboardUpdateV2
import ai.q9labs.chalk.meetingkit.ChalkWhiteboardWebViewCodec
import ai.q9labs.chalk.nativeapp.MainViewModel
import kotlinx.coroutines.launch
import org.json.JSONObject

private class ChalkJsBridge(
	private val mainHandler: Handler,
	private val onMessage: (String) -> Unit,
) {
	@JavascriptInterface
	fun postMessage(raw: String) {
		// Called on a binder thread; dispatch to main to touch WebView / Compose state.
		mainHandler.post { onMessage(raw) }
	}
}

private fun WebView.sendEnvelopeToJs(rawJson: String) {
	val quoted = JSONObject.quote(rawJson)
	evaluateJavascript("window.__chalkNativeOnMessage($quoted);", null)
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WhiteboardWebView(
	vm: MainViewModel,
	modifier: Modifier = Modifier,
	theme: String = "dark",
) {
	val mainHandler = remember { Handler(Looper.getMainLooper()) }
	val scope = rememberCoroutineScope()

	var webView: WebView? by remember { mutableStateOf(null) }
	var isReady by remember { mutableStateOf(false) }

	fun sendToJs(rawJson: String) {
		val wv = webView ?: return
		if (!isReady) return
		wv.sendEnvelopeToJs(rawJson)
	}

	LaunchedEffect(Unit) {
		vm.whiteboardEvents.collect { ev ->
			sendToJs(ChalkWhiteboardWebViewCodec.fromEvent(ev))
		}
	}

	AndroidView(
		modifier = modifier.fillMaxSize(),
		factory = { ctx ->
			WebView(ctx).apply {
				settings.javaScriptEnabled = true
				settings.domStorageEnabled = true
				settings.allowFileAccess = true
				webChromeClient = WebChromeClient()
				webViewClient = object : WebViewClient() {
					override fun onPageFinished(view: WebView?, url: String?) {
						isReady = true
						sendToJs(ChalkWhiteboardWebViewCodec.init(canDraw = true, theme = theme))
						vm.requestWhiteboardSync()
					}
				}

				addJavascriptInterface(
					ChalkJsBridge(mainHandler) { raw ->
						handleWebViewMessage(scope, vm, this, raw)
					},
					"ChalkNativeBridge",
				)

				// Assets are generated at build time from `apps/native/whiteboard-web`.
				loadUrl("file:///android_asset/whiteboard/index.html")

				webView = this
			}
		},
		update = { wv ->
			webView = wv
		},
	)
}

private fun handleWebViewMessage(
	scope: kotlinx.coroutines.CoroutineScope,
	vm: MainViewModel,
	webView: WebView,
	raw: String,
) {
	val env = runCatching { JSONObject(raw) }.getOrNull() ?: return
	val type = env.optString("type", "")
	val requestId = env.optString("requestId", "").takeIf { it.isNotBlank() }
	val payload = env.optJSONObject("payload")

	when (type) {
		"wb.sendUpdateV2" -> {
			if (payload == null) return
			val sceneId = payload.optString("sceneId", "")
			val syncAll = payload.optBoolean("syncAll", false)
			val seq = payload.optLong("seq", -1L).takeIf { it >= 0 }
			val elementsJson = payload.optJSONArray("elements")?.toString() ?: "[]"
			vm.sendWhiteboardUpdateV2(
				ChalkWhiteboardUpdateV2(
					sceneId = sceneId,
					syncAll = syncAll,
					elementsJson = elementsJson,
					seq = seq,
				),
			)
		}
		"wb.sendCursor" -> {
			if (payload == null) return
			vm.sendWhiteboardCursor(
				x = payload.optDouble("x", 0.0),
				y = payload.optDouble("y", 0.0),
			)
		}
		"wb.requestSync" -> vm.requestWhiteboardSync()
		"wb.sendClear" -> vm.clearWhiteboard()
		"wb.presignUpload" -> {
			if (payload == null || requestId == null) return
			val fileId = payload.optString("fileId", "")
			val mimeType = payload.optString("mimeType", "image/png")
			scope.launch {
				val msg = runCatching {
					val res: ChalkPresignUpload = vm.presignWhiteboardUpload(fileId, mimeType)
					ChalkWhiteboardWebViewCodec.presignUploadResult(
						requestId = requestId,
						uploadUrl = res.uploadUrl,
						expiresAtMs = res.expiresAtMs,
					)
				}.getOrElse { err ->
					ChalkWhiteboardWebViewCodec.presignUploadResult(requestId = requestId, error = err.message ?: "presign upload failed")
				}
				webView.sendEnvelopeToJs(msg)
			}
		}
		"wb.presignDownload" -> {
			if (payload == null || requestId == null) return
			val fileId = payload.optString("fileId", "")
			scope.launch {
				val msg = runCatching {
					val res: ChalkPresignDownload = vm.presignWhiteboardDownload(fileId)
					ChalkWhiteboardWebViewCodec.presignDownloadResult(
						requestId = requestId,
						downloadUrl = res.downloadUrl,
						expiresAtMs = res.expiresAtMs,
					)
				}.getOrElse { err ->
					ChalkWhiteboardWebViewCodec.presignDownloadResult(requestId = requestId, error = err.message ?: "presign download failed")
				}
				webView.sendEnvelopeToJs(msg)
			}
		}
	}
}
