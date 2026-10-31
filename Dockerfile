FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3-venv ca-certificates \
        libx11-6 libxext6 libxrender1 libgl1 libglu1-mesa libgomp1 libatomic1 \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/sumo-venv \
    && /opt/sumo-venv/bin/pip install --no-cache-dir eclipse-sumo==1.28.0 traci==1.28.0 sumolib==1.28.0 \
    && /opt/sumo-venv/bin/python -c "import pathlib, sumo; pathlib.Path('/opt/sumo-home').symlink_to(sumo.SUMO_HOME)" \
    && /opt/sumo-venv/bin/sumo --version \
    && /opt/sumo-venv/bin/netconvert --version
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    SERVE_FRONTEND=true \
    SUMO_PYTHON=/opt/sumo-venv/bin/python \
    SUMO_HOME=/opt/sumo-home \
    PATH="/opt/sumo-venv/bin:${PATH}"
WORKDIR /app
COPY --chown=node:node backend ./backend
COPY --from=frontend --chown=node:node /app/dist ./dist
USER node
EXPOSE 8000
CMD ["node", "backend/server.mjs"]
