FROM python:3.14-slim

# Install system dependencies required by yt-dlp and general media handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/
COPY run.py .

# Create directories for media storage
RUN mkdir -p app/static/media app/static/media/artworks && chmod -R 755 app/static/media

# Expose the Flask port
EXPOSE 5000

# Run the application
CMD ["python", "run.py"]
