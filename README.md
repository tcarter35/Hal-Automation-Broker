# Hal Automation Broker — Home Assistant app repository

Standalone repository packaging of the existing broker. Startup forces `HAL_BROKER_ALLOW_WRITES=0`; approval/apply requests remain blocked with `423 WRITE_DISABLED`. No host port or ingress is declared. Proposals persist at `/data/proposals.json`.

## Layout and build

The repository root contains `repository.yaml`; Supervisor's Docker build context is `hal_automation_broker/`. Its Dockerfile copies `app/` and `rootfs/` from this context. `build.yaml` uses current `args.BUILD_FROM` with the architecture placeholder, not deprecated `build_from`. Architectures are amd64, aarch64, and legacy armv7, matching the existing image bases.

Replace the URL and maintainer placeholders in `repository.yaml` before publishing. No push was performed.

## Security and storage

The broker binds `0.0.0.0:8765` only inside the private app network. `ports`, `host_network`, and `ingress` are absent. Only the app `addon_config` directory is mapped read-only at `/config`; there is no Core API, Supervisor API, Docker socket, or host access. Credentials and the live MCP config are excluded; `mcporter.json.template` is not a credential.

After registration, provision distinct worker, HA-integration, and MCP credentials into the app config directory using the guarded provisioning procedure from the original source distribution. Use a dedicated least-privilege MCP identity, never the OpenClaw credential or an HA administrator token. Provisioning suppresses token echo and writes private files. Confirm the actual internal hostname from Home Assistant Core before configuring clients.

## Startup and health

S6 runs `rootfs/etc/services.d/hal_automation_broker/run`, which invokes `rootfs/usr/local/bin/hal-broker-start`. Missing private files or required read-only MCP tools produce a concise startup error without secret values. Docker healthcheck probes `/healthz` over container loopback; it is liveness-only.

## Verification

Run source regressions with `npm test` in the original source checkout and package smoke checks in the source distribution. Build using official Home Assistant app tooling on each target architecture before publishing. Image build and actual Supervisor hostname require validation in the HA installation.
