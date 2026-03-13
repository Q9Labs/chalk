FROM nvidia/cuda:12.3.2-cudnn9-runtime-ubuntu22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Create log directory
RUN mkdir -p /var/log && touch /var/log/whisper-worker.log

# Install uv (Python package manager)
ENV UV_NO_MODIFY_PATH=1
ENV UV_CACHE_DIR=/tmp/uv-cache
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Create virtualenv + install deps
RUN uv venv /app/.venv
ENV VIRTUAL_ENV=/app/.venv
ENV PATH="${VIRTUAL_ENV}/bin:${PATH}"

# Install Python dependencies
COPY requirements.txt .
RUN uv pip install -r requirements.txt && rm -rf /tmp/uv-cache

# Optionally pre-download the Whisper model to bake it into the image.
# Disabled by default so lower-memory builders can still produce the runtime image.
ARG WHISPER_MODEL=distil-large-v3.5
ARG PRELOAD_WHISPER_MODEL=false
ENV WHISPER_MODEL=${WHISPER_MODEL}
RUN if [ "${PRELOAD_WHISPER_MODEL}" = "true" ]; then \
      python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu')"; \
    fi

# Copy worker script + modules
COPY worker.py worker_types.py transcriber.py env_utils.py worker_config.py audio_download.py observability.py otel.py gpu_metrics.py worker_queue.py worker_metrics.py job_processor.py transcribe_file.py .

# Default environment variables
ENV REDIS_URL=redis://localhost:6379
ENV WHISPER_DEVICE=cuda
ENV WHISPER_COMPUTE_TYPE=float16
ENV LOG_LEVEL=INFO

# Health check - verify faster-whisper imports successfully
HEALTHCHECK --interval=30s --timeout=30s --start-period=60s --retries=3 \
    CMD python3 -c "from faster_whisper import WhisperModel; print('OK')" || exit 1

# Run worker
CMD ["python3", "worker.py"]
