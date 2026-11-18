# Pinned by digest so two builds of the same commit give the same image. To
# update, take the digests from `docker buildx imagetools inspect <image>:<tag>`.
FROM python:3.14.10@sha256:e5de6bc932256f8138c2353023dc4fd24d010d72f6b5cb06be126f0a4cd53784 AS builder

COPY --from=ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d /uv /uvx /bin/

ENV UV_PROJECT_ENVIRONMENT=/opt/venv
ENV UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Install external deps without building workspace members.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=VERSION,target=VERSION \
    uv sync --frozen --no-dev --no-install-workspace --package hackbot-agent-autowebcompat-etp

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,target=/app,rw \
    uv sync --locked --no-dev --no-editable --package hackbot-agent-autowebcompat-etp

FROM python:3.14.10@sha256:e5de6bc932256f8138c2353023dc4fd24d010d72f6b5cb06be126f0a4cd53784 AS base

WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PATH="/opt/venv/bin:$PATH"

FROM base AS agent

# The agent needs Node.js + npm to run the Firefox DevTools MCP server (an npm
# package; the python base ships neither) and the shared libraries Firefox
# requires. The Firefox binary itself is downloaded at agent startup via
# mozdownload/mozinstall (see browser.py). Unlike autowebcompat-repro there is
# no Chrome: the comparison is Firefox Standard vs Strict ETP, so the image also
# runs natively on arm64.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        # Node.js, to run the Firefox DevTools MCP server.
        nodejs npm \
        ca-certificates \
        # Firefox runtime deps.
        libgtk-3-0 libdbus-glib-1-2 libx11-xcb1 libxtst6 libxt6 libpci3 \
        libasound2t64 fonts-liberation \
        # Codecs and audio/video related dependencies
        ffmpeg \
        # Window manager and display backend
        fluxbox \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install the DevTools MCP server from the pinned package.json/lockfile, then
# add the agent's ETP tools to it (see mcp/patch-mcp.mjs).
COPY agents/autowebcompat-etp/package.json \
     agents/autowebcompat-etp/package-lock.json \
     /app/etp/
COPY agents/autowebcompat-etp/mcp /app/etp/mcp
RUN cd /app/etp && npm ci --omit=dev \
    && node mcp/patch-mcp.mjs node_modules/@mozilla/firefox-devtools-mcp-moz

# hackbot.toml lives at the agent root (not inside the package), so copy it into
# the working dir; the runtime discovers it there (cwd) at startup.
COPY agents/autowebcompat-etp/hackbot.toml /app/hackbot.toml

RUN useradd --create-home --shell /bin/bash agent \
    && mkdir -p /workspace \
    && chown agent:agent /workspace /app/etp

ENV SCREEN_WIDTH=1280
ENV SCREEN_HEIGHT=1024
ENV SCREEN_DEPTH=24
ENV DISPLAY=:99.0

USER agent

COPY --from=builder /opt/venv /opt/venv

CMD ["python", "-m", "hackbot_agents.autowebcompat_etp"]

FROM base AS broker

RUN useradd --create-home --shell /bin/bash broker

USER broker

EXPOSE 8765

COPY --from=builder /opt/venv /opt/venv

CMD ["python", "-m", "hackbot_agents.autowebcompat_etp.broker"]
