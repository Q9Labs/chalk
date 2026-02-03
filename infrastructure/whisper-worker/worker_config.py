from __future__ import annotations

import os

from env_utils import env_bool, env_float, env_int

JOB_QUEUE = "transcription:jobs"
RESULT_KEY_PREFIX = "transcription:result:"
RESULT_TTL_SECONDS = 24 * 60 * 60  # 24 hours
POLL_TIMEOUT_SECONDS = 30

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
REDIS_CONNECT_TIMEOUT = env_float("REDIS_CONNECT_TIMEOUT", 5.0)
REDIS_SOCKET_TIMEOUT = env_float("REDIS_SOCKET_TIMEOUT", POLL_TIMEOUT_SECONDS + 5)
REDIS_RETRY_ON_TIMEOUT = env_bool("REDIS_RETRY_ON_TIMEOUT", True)
REDIS_HEALTHCHECK_INTERVAL = env_int("REDIS_HEALTHCHECK_INTERVAL", 30)

LOG_TRANSCRIPT = env_bool("WHISPER_LOG_TRANSCRIPT", False)
LOG_TRANSCRIPT_MAX_CHARS = env_int("WHISPER_LOG_TRANSCRIPT_MAX_CHARS", 4000)
