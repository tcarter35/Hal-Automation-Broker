# Hal Automation Broker — Home Assistant app repository

Read-only proposal broker for Home Assistant. Writes are hard-disabled on startup with `HAL_BROKER_ALLOW_WRITES=0`; approval/apply requests return `423 WRITE_DISABLED`. No host port or ingress is declared. Proposals persist at `/data/proposals.json`.

## Install and connect

Install through the Home Assistant app repository. Its app configuration directory is `app_configs/<app-id>/` (the installed ID may be `local_hal_automation_broker` for a local install).

Create the **private** file `secrets.env` there with these four values:

```dotenv
HAL_BROKER_WORKER_TOKEN=REPLACE_WITH_FRESH_RANDOM_SECRET
HAL_BROKER_HA_TOKEN=REPLACE_WITH_DIFFERENT_FRESH_RANDOM_SECRET
HAL_BROKER_HMAC_KEY=REPLACE_WITH_BASE64_32_BYTE_RANDOM_SECRET
HAL_MCP_BASE_URL=http://HOME_ASSISTANT_IP:9583/private_YOUR_SECRET_PATH
```

The full `HAL_MCP_BASE_URL` comes from the **Home Assistant MCP Server app logs** and is itself a credential. **Never paste it in GitHub, chat, or logs.** This MCP app authenticates with the secret URL; a Bearer header and `HAL_MCP_TOKEN` are **not required**. The broker generates its private MCPorter configuration at runtime. An old `mcporter.json` in the app config directory is ignored by this version.

For security, use a dedicated least-privilege MCP identity when available. The broker's MCPorter call allowlist contains only `ha_search` and `ha_config_get_automation`, but this does not reduce the underlying MCP server's own permissions. Do not expose this server outside your trusted network.

## Startup and health

S6 runs `rootfs/etc/services.d/hal_automation_broker/run`. Startup checks the required secrets and read-only MCP tool schema. Errors do not print the secret URL. Docker healthcheck probes `/healthz` over container loopback.

App root contains `Dockerfile`, `config.yaml`, `build.yaml`, `app/` and `rootfs/`. The container has no Docker socket, HA Core API, Supervisor API, host-network access, exposed port, or ingress. The app's private configuration folder is mapped read-only to `/config`.

## Verification

Source and isolated package smoke tests are provided. Docker build and live Supervisor integration require testing on a Home Assistant installation. **Installing this app does not enable real automation creation.**
