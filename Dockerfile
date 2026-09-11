FROM oven/bun:1 AS base
WORKDIR /app

# System deps: python3 for the markitdown CLI (binary uploads), build tools for native bindings
RUN apt-get update -qq && apt-get install -y -qq \
    build-essential python3 python3-pip python3-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python venv with markitdown (binary upload conversion)
RUN python3 -m venv /opt/cv-venv \
    && /opt/cv-venv/bin/pip install --no-cache-dir "markitdown[pptx,pdf,docx,xlsx]==0.1.7"

# JS deps (--ignore-scripts: onnxruntime-node's NuGet postinstall fails under Bun 1.4
# in the builder; the hoisted onnxruntime-node@1.29.0 ships its own prebuilt binary)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# App (no models baked — downloaded on first use into the volume, D02)
COPY src ./src
COPY web ./web
COPY config.example.toml ./
# Pre-create config.toml as a file so a bind-mount (docker-compose) replaces it
# instead of shadowing it with a directory
RUN touch config.toml

ENV CONFIG_PATH=/app/config.toml
EXPOSE 8787
CMD ["bun", "src/index.ts"]