# --- Stage 1: Build the React Frontend ---
FROM node:18-alpine as build-frontend
WORKDIR /app/frontend

# Copy package files and install dependencies
COPY frontend/package*.json ./
RUN npm ci

# Copy source code and build
COPY frontend/ ./
RUN npm run build

# Fail fast if Vite didn't produce the expected file
RUN echo "=== frontend dist contents ===" \
  && ls -la /app/frontend \
  && ls -la /app/frontend/dist \
  && test -f /app/frontend/dist/index.html

# --- Stage 2: Build the Python Backend ---
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (needed for some Python packages)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential && rm -rf /var/lib/apt/lists/*

RUN pip install poetry

COPY backend/pyproject.toml backend/poetry.lock* /app/
# Disable virtualenv creation so poetry installs into the system python
RUN poetry config virtualenvs.create false && poetry install --no-interaction --no-ansi --no-root --with eval

# Copy the Backend Code
COPY backend /app/backend

# Copy the Built Frontend from Stage 1 into the Backend's static folder
COPY --from=build-frontend /app/frontend/dist /app/backend/src/static

# Fail fast if the copy didn't land as expected
RUN echo "=== backend static contents ===" \
  && ls -la /app/backend/src/static \
  && test -f /app/backend/src/static/index.html

# A. Ensure 'backend' is treated as a package (creates empty __init__.py if missing)
RUN touch /app/backend/__init__.py

# B. Explicitly add /app to the Python path
ENV PYTHONPATH=/app:/app/backend/src

# Expose the port
EXPOSE 8000

# Run the server
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]