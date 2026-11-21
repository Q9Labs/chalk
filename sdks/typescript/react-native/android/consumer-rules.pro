# The unpatched WebRTC dependency remains a supported data-only fallback.
-keepclassmembers class com.cloudflare.realtimekit.WebRTCModule.WebRTCModule {
    public void setChalkScreenVideoProcessor(java.lang.String, realtimekit.org.webrtc.VideoProcessor, java.util.function.Consumer);
}
