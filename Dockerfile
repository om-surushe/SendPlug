FROM python:3.10-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PATH="/home/appuser/.local/bin:$PATH"

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user and set up the application directory
RUN useradd -m appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser
WORKDIR /app

# Copy requirements first to leverage Docker cache
COPY --chown=appuser:appuser requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY --chown=appuser:appuser src/ /app/

# Expose the SMTP and HTTP ports
EXPOSE 8025 8000

# Health check for both SMTP and HTTP services
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health && nc -z localhost 8025 || exit 1

# Set environment variables for the API
ENV HTTP_HOST=0.0.0.0 \
    HTTP_PORT=8000 \
    API_PREFIX=/api/v1 \
    DEBUG=false

# Run the server
CMD ["python", "-m", "src.server"]
