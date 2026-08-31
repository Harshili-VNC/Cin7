# Cin7 Sync API - Container image for Azure Container Apps
#
# IMPORTANT: build this from the `build/` directory (one level up from
# this file's sibling folders), e.g.:
#   cd build/
#   docker build -t cin7-sync-api .
# This is required so Docker's build context includes both
# container_app/ and shared/.
FROM python:3.12-slim

# Run as non-root user, not root - basic container security hygiene
RUN useradd --create-home appuser
WORKDIR /app

COPY container_app/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the shared logic (cin7_client, db, encryption, ms_graph, sync_logic)
# and this service's own code
COPY shared/ /app/shared/
COPY container_app/ /app/

# Secrets (DATABASE_URL, ENCRYPTION_KEY, SYNC_API_KEY, AZURE_APP_CLIENT_SECRET)
# are NOT copied in here. They must be injected at runtime as environment
# variables via Container Apps' built-in Key Vault secret references -
# never baked into this image.

USER appuser
EXPOSE 8000

CMD ["uvicorn", "api_service:app", "--host", "0.0.0.0", "--port", "8000"]
