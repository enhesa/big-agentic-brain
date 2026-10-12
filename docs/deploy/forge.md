# Worked example: Enhesa Forge

How Enhesa runs BAB on its internal Forge platform. Use it as a template for your own environment.

## Image

Build with the internal mirror of the base image:

```bash
docker build --build-arg BASE_IMAGE=devenhesacontainerregistry.azurecr.io/enhesabase/node:24-alpine .
```

The Forge repository will carry this repository as a git subtree under `upstream/`, with the Forge-specific files layered on top (Plan 3).

## Environment

| Variable | Value |
|---|---|
| `BAB_IDENTITY_EMAIL_PATTERN` | `^[a-z]+(?:[-'][a-z]+)*\.[a-z]+(?:[-'.][a-z]+)*@enhesa\.com$` |
| `BAB_IDENTITY_ALIAS_PATTERN` | `^[a-z0-9._%+-]+@enhesa\.com$` |
| `BAB_IDENTITY_HINT` | `first.last@enhesa.com` |
| `BAB_TRUST_PROXY_IDENTITY` | `1` |
| `BAB_HEADER_USER_ID` | `x-forge-user-id` |
| `BAB_HEADER_EMAIL` | `x-forge-user-email` |
| `BAB_HEADER_NAME` | `x-forge-user-name` |
| `BAB_HEADER_ROLES` | `x-forge-roles` |
| `BAB_TRUST_PROXY` | `1` |
| `BAB_PUBLIC_ORIGIN` | `https://bab.forge.enhesa.com` |
| `BAB_REDACT_DOMAINS` | `enhesa.com,enhesa.ai,anthropic.com` |
| `BAB_SOURCE_HOSTS` | `enhesa.atlassian.net` |
| `BAB_PROJECT_KEY_PREFIXES` | `enhesacorp.,enhesa.` |
| `BAB_ORG_NAME` | `Enhesa` |
| `BAB_PLUGIN_MARKETPLACE` | `enhesa/enhesa.claude.plugins` |
| `BAB_PLUGIN_MARKETPLACE_NAME` | `enhesa-plugins` |
| `BAB_AUDIT_RETENTION_DAYS` | `180` |
| `BAB_LOCALE` | `en-GB` |
| `BAB_CLIENT_IP_HEADER` | `x-real-ip` |
| `BAB_MAINTAINERS` | the maintainers' long-form emails, comma-separated |

## SSO public paths

These paths skip the Forge login (BAB applies its own identity rules):

- `/instructions/*`
- `/api/*`
- `/mcp`
- `/readyz`
- `/favicon.ico`, `/sw.js`
- Static asset paths served by Next, not listed in `lib/public-paths.ts`: `/icons/*`, `/branding/*`, `/fonts/*`
