---
name: docker-patterns
description: A collection of Docker / Docker Compose best practices covering multi-stage builds, layer caching, image size reduction, security, healthchecks, and Compose-based dev environment setup. Reference this when creating, modifying, or reviewing a Dockerfile or docker-compose.yml.
---

# Docker Patterns

A skill that captures the decision criteria for writing Dockerfiles and Docker Compose files.
When starting from scratch, work through this order: base image selection → stage separation → cache optimization → security → healthchecks.

## Multi-Stage Builds

Separate the build stage from the runtime stage so that build-only tooling (compilers, devDependencies, the Composer binary, etc.) never ends up in the runtime image.

Benefits:
- The runtime image is smaller, which speeds up distribution and deployment
- Vulnerabilities originating from build tools don't linger in the runtime environment
- Source code and intermediate build artifacts can't leak into the final image

### Node.js example

```dockerfile
# Good: use devDependencies in the build stage, hand only the build output to runtime
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/main.js"]
```

### Python example

```dockerfile
# Good: copy only the installed dependency output into the runtime stage
FROM python:3.12-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --prefix=/install --no-cache-dir -r requirements.txt

FROM python:3.12-slim AS runtime
WORKDIR /app
COPY --from=build /install /usr/local
COPY . .
RUN useradd --create-home --shell /usr/sbin/nologin appuser
USER appuser
CMD ["python", "-m", "app"]
```

Keep compiler packages such as build-essential confined to the build stage. Only bring the artifacts installed via `--prefix` into the runtime stage.

### PHP-FPM example

```dockerfile
# Good: resolve dependencies in a composer stage, ship only vendor/ into the runtime image
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --prefer-dist --no-scripts --no-interaction

FROM php:8.3-fpm AS runtime
WORKDIR /var/www/html
RUN docker-php-ext-install pdo_mysql opcache
COPY --from=vendor /app/vendor ./vendor
COPY . .
RUN chown -R www-data:www-data /var/www/html
USER www-data
CMD ["php-fpm"]
```

This keeps the (tens-of-MB) Composer binary and any dev-only dependencies excluded via `--no-dev` out of the runtime image.

## Layer Caching

Docker caches layers individually and re-executes every layer from the point where the copied content first changes. Dependency manifests (lock files) change far less often than source code, so copy them in on their own first, letting the dependency-install step ride the cache.

```dockerfile
# Bad: even a one-line source change forces npm ci to run every time
COPY . .
RUN npm ci

# Good: npm ci stays cached as long as the lock file doesn't change
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
```

Files to copy first, by language:
- Node.js: package.json and package-lock.json (or pnpm-lock.yaml / yarn.lock)
- Python: requirements.txt (or pyproject.toml plus poetry.lock / uv.lock)
- PHP: composer.json and composer.lock

Additional notes:
- Always combine `apt-get update` and `apt-get install` into a single `RUN`. Splitting them lets a stale package-list layer get reused, causing the install to fail or pull outdated versions.
- Place instructions that change less often earlier in the Dockerfile.

## Reducing Image Size

### Choosing between slim and alpine

- slim (Debian-based): the default choice. glibc-compatible, so native extensions and prebuilt binaries work out of the box.
- alpine (musl-based): reserve this for when you truly need the smallest possible size. Watch out for:
  - Prebuilt binaries that assume glibc may not run under musl libc
  - Python loses access to manylinux wheels, forcing a source build that's slower and often needs extras like build-base
  - Node.js native modules (sharp, bcrypt, etc.) may also need rebuilding
  - Subtle behavioral differences (e.g., DNS resolution) that are hard to debug

When in doubt, choose slim. Reserve alpine for cases with no native dependencies, or where image size constraints are strict.

### .dockerignore

Keeps the build context small and prevents unwanted or sensitive files from leaking into the image. Always place one at the project root.

```
# baseline .dockerignore
.git
node_modules
vendor
__pycache__
*.log
.env
.env.*
dist
coverage
Dockerfile
docker-compose*.yml
```

Without a `.dockerignore`, a Dockerfile using `COPY . .` will bake `.env` and `.git` straight into the image.

## Security

### Run as a non-root user

Running the container process as root widens the blast radius if a vulnerability is exploited.

```dockerfile
# Bad: no USER directive (runs as root)
CMD ["node", "server.js"]

# Good: use the user bundled with the official image (node for Node.js, www-data for php-fpm)
USER node
CMD ["node", "server.js"]
```

For images that don't ship a ready-made user, create one with `useradd` (see the Python example above). `chown` any directories that need write access before switching `USER`.

### Never bake secrets into the image

Secrets passed via ARG / ENV / COPY can be recovered from `docker history` or by inspecting layers. Removing a file with `rm` in a later layer does not remove it from earlier layers.

```dockerfile
# Bad: the build-arg value persists in the image history
ARG NPM_TOKEN
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc \
    && npm ci && rm .npmrc

# Good: BuildKit secret mounts never land in a layer
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

Pass the secret at build time with something like `docker build --secret id=npmrc,src=$HOME/.npmrc .`. For runtime secrets, use environment variables (Compose's `env_file`) or a secrets-management backend, and add `.env` files to both `.dockerignore` and `.gitignore`.

### Pin versions (never use `latest`)

```dockerfile
# Bad: content changes depending on when the image is pulled, breaking reproducibility
FROM node:latest
FROM python

# Good: pin at least major.minor
FROM node:22-slim
FROM python:3.12-slim

# Good: pin by digest when you need strict reproducibility
FROM node:22-slim@sha256:<digest>
```

Pin versions for apt/pip packages too whenever reproducibility matters.

## Healthchecks

### Dockerfile HEALTHCHECK

```dockerfile
# Good: poll the app's health endpoint on a schedule
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:3000/healthz || exit 1
```

On slim-family images that lack `curl`, fall back to `wget` or a check written in the language runtime itself (e.g. `CMD ["node", "healthcheck.js"]`).

### Compose healthcheck and depends_on

By default, `depends_on` only guarantees *startup order*, not readiness. To wait until a database is actually ready to accept connections, combine `healthcheck` with a `condition`.

```yaml
services:
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  api:
    build: .
    depends_on:
      db:
        condition: service_healthy   # don't start api until db is healthy
```

Condition types:
- `service_started`: wait only for the container to start (default)
- `service_healthy`: wait until the healthcheck succeeds
- `service_completed_successfully`: wait for a one-shot task (e.g. a migration) to exit successfully

## Compose-Based Development Environments

### Choosing between volume types

- Named volumes: for persistent data you want to survive container rebuilds, such as database data
- Bind mounts: for things like source code, where you want host-side edits reflected immediately

```yaml
services:
  api:
    build: .
    volumes:
      - .:/app                  # source via bind mount (for hot reload)
      - /app/node_modules       # don't let the host's node_modules overwrite the container's
  db:
    image: postgres:16
    volumes:
      - db-data:/var/lib/postgresql/data   # data via named volume

volumes:
  db-data:
```

### Override files

Keep the base definition in `docker-compose.yml`, and isolate dev-only differences (bind mounts, debug ports, dev commands) in `docker-compose.override.yml`. Since `docker compose up` merges the override file automatically, production and CI should explicitly pass `-f docker-compose.yml` only, excluding the dev-only overrides.

### Bind ports to localhost

```yaml
    # Bad: exposed on all interfaces, reachable from the LAN or beyond
    ports:
      - "5432:5432"

    # Good: bind a dev database to the loopback interface only
    ports:
      - "127.0.0.1:5432:5432"
```

For services the host never needs to reach directly, skip `ports` entirely and rely on container-to-container communication (via service-name resolution).

### Network isolation

Minimize the reachable surface. Put only the reverse proxy on the outward-facing network, and keep the database reachable solely from the app.

```yaml
services:
  proxy:
    networks: [frontend]
  api:
    networks: [frontend, backend]
  db:
    networks: [backend]    # unreachable from proxy

networks:
  frontend:
  backend:
```

## Anti-Patterns

- Specifying a base image as `FROM xxx:latest` (breaks reproducibility)
- Writing `COPY . .` before the dependency-install step (invalidates the cache on every build)
- Running `COPY . .` without a `.dockerignore` (leaks `.git` or `.env` into the image)
- Passing secrets via ARG / ENV (recoverable from `docker history`)
- Running the app as root because `USER` was never set
- Splitting `apt-get update` and `apt-get install` into separate `RUN` instructions
- Leaving the apt cache (`/var/lib/apt/lists`) or pip cache in the image instead of clearing it
- Cramming multiple processes into one container (app + cron + nginx, etc.)
- Assuming `depends_on` alone guarantees the database is ready (no `condition` specified)
- Exposing a dev database port on `0.0.0.0`
- Reaching for alpine without considering native extension compatibility
- Writing logs to a file instead of stdout/stderr (let the runtime handle log collection)
- Running `git clone` inside the image instead of `COPY`-ing through the build context

## Related

- Use `/code-review` when reviewing Dockerfile / Compose file changes
