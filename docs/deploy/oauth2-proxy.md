# oauth2-proxy

A minimal setup with [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) and nginx in front of BAB. oauth2-proxy signs people in and nginx sets the identity headers BAB trusts.

## BAB settings

```yaml
  bab:
    build: .
    volumes: [bab-data:/data]
    environment:
      BAB_PUBLIC_ORIGIN: https://bab.example.com
      BAB_TRUST_PROXY: "1"
      BAB_TRUST_PROXY_IDENTITY: "1"
      BAB_PROXY_SECRET: change-me-long-random
      BAB_CLIENT_IP_HEADER: x-real-ip
```

BAB refuses to start with `BAB_TRUST_PROXY_IDENTITY` on and no `BAB_PROXY_SECRET`. Only when the proxy is the only way to reach BAB (nothing else can connect to the pod), set `BAB_TRUST_PROXY_WITHOUT_SECRET=1` instead; BAB then starts with a warning.

The default header names already match oauth2-proxy's `--set-xauthrequest`: `x-auth-request-user`, `x-auth-request-email`, `x-auth-request-preferred-username` and `x-auth-request-groups`. Change them with `BAB_HEADER_USER_ID`, `BAB_HEADER_EMAIL`, `BAB_HEADER_NAME` and `BAB_HEADER_ROLES`.

## oauth2-proxy

```yaml
  oauth2-proxy:
    image: quay.io/oauth2-proxy/oauth2-proxy:latest
    command:
      - --provider=oidc
      - --oidc-issuer-url=https://login.example.com
      - --client-id=...
      - --client-secret=...
      - --cookie-secret=...
      - --email-domain=example.com
      - --http-address=0.0.0.0:4180
      - --reverse-proxy=true
      - --set-xauthrequest=true
```

## nginx

nginx asks oauth2-proxy to authenticate, copies the identity headers, and adds the shared secret as `x-bab-proxy-secret`. Setting a header with `proxy_set_header` replaces whatever the client sent.

```nginx
# Web pages: sign in, then pass the identity and the shared secret.
location / {
    auth_request /oauth2/auth;
    auth_request_set $user   $upstream_http_x_auth_request_user;
    auth_request_set $email  $upstream_http_x_auth_request_email;
    auth_request_set $name   $upstream_http_x_auth_request_preferred_username;
    auth_request_set $groups $upstream_http_x_auth_request_groups;
    error_page 401 = /oauth2/sign_in;

    proxy_set_header x-auth-request-user $user;
    proxy_set_header x-auth-request-email $email;
    proxy_set_header x-auth-request-preferred-username $name;
    proxy_set_header x-auth-request-groups $groups;
    proxy_set_header x-bab-proxy-secret change-me-long-random;
    proxy_set_header x-real-ip $remote_addr;
    proxy_pass http://bab:3000;
}

# Agent and asset paths: no sign-in, and no identity headers from the client.
location ~ ^/(api(/|$)|mcp(/|$)|healthz$|readyz$|instructions(/|$)|branding/|fonts/|icons/|icon\.svg$|apple-icon\.png$|favicon\.ico$|sw\.js$|inbox/manifest$) {
    proxy_set_header x-auth-request-user "";
    proxy_set_header x-auth-request-email "";
    proxy_set_header x-auth-request-preferred-username "";
    proxy_set_header x-auth-request-groups "";
    proxy_set_header x-bab-proxy-secret "";
    proxy_set_header x-real-ip $remote_addr;
    proxy_pass http://bab:3000;
}

location /oauth2/ { proxy_pass http://oauth2-proxy:4180; }
```

The regular-expression location covers every path in the list below; nginx prefers it over `location /` for those paths.

## Paths to keep public at the proxy

Agents cannot sign in through a browser, so skip the login on these paths (BAB applies its own identity rules there). Clear any identity headers and the proxy secret header on them, so a client cannot send its own.

- `/healthz`, `/readyz`
- `/api/*`
- `/mcp`
- `/instructions/*`
- `/favicon.ico`, `/icon.svg`, `/apple-icon.png`, `/sw.js`, `/inbox/manifest`
- Static asset paths served by Next, not listed in `lib/public-paths.ts`: `/branding/*`, `/fonts/*`, `/icons/*`

Everything else, the web pages, stays behind the login.

## Agents

The proxy protects the web pages only. Agents on `/api` and `/mcp` skip the login and say who they are themselves, so anyone who can reach those paths can claim any address. BAB logs a warning at startup while they accept self-declared identities: with the proxy identity on and no tokens, or whenever any bare token is configured, even next to `token=email` entries (a bare token gates access but does not say who the holder is). Either set `BAB_API_TOKENS` with one `token=email` entry per person or team, or keep `/api` and `/mcp` on the private network.

```yaml
      BAB_API_TOKENS: "tokenA=alice@example.com,tokenB=bob@example.com"
```

Agents then send the token with every call:

```
Authorization: Bearer tokenA
```

An address bound to a token can only be used with that token: not through the `X-Bab-Actor-*` headers, a remembered device or connection, `bab_identify`, or identity headers sent to `/api` or `/mcp` (the proxy's headers count only when the request carries that token). Still clear the identity headers on those paths, as above, and set `BAB_PROXY_SECRET` where you can.
