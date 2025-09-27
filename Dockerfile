# Build stage
FROM python:3.10-slim as builder

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip wheel --no-cache-dir --no-deps --wheel-dir /app/wheels -r requirements.txt

# Runtime stage
FROM python:3.10-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PATH="/home/appuser/.local/bin:$PATH"

# Create a non-root user and set up the application directory
RUN useradd -m appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser
WORKDIR /app

# Copy wheels from builder and install dependencies
COPY --from=builder --chown=appuser:appuser /app/wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r /wheels/requirements.txt && \
    rm -rf /wheels

# Copy application code
COPY --chown=appuser:appuser src/ /app/

# Expose the SMTP port
EXPOSE 8025

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD nc -z localhost 8025 || exit 1

# Run the server
CMD ["python", "-m", "src.server"]
