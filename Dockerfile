FROM node:24-alpine AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && useradd --system --create-home medix
COPY backend/ ./backend/
COPY --from=frontend /build/dist ./frontend/dist
USER medix
EXPOSE 8008
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8008", "--no-access-log"]
