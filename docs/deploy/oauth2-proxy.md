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
location / {
    auth_request /oauth2/auth;
    auth_request_set $user  $upstream_http_x_auth_request_user;
    auth_request_set $email $upstream_http_x_auth_request_email;
    auth_request_set $name  $upstream_http_x_auth_request_preferred_username;
    error_page 401 = /oauth2/sign_in;

    proxy_set_header x-auth-request-user $user;
    proxy_set_header x-auth-request-email $email;
    proxy_set_header x-auth-request-preferred-username $name;
    proxy_set_header x-bab-proxy-secret change-me-long-random;
    proxy_set_header x-real-ip $remote_addr;
    proxy_pass http://bab:3000;
}
location /api/ {
    proxy_set_header x-auth-request-user "";
    proxy_set_header x-auth-request-email "";
    proxy_set_header x-auth-request-preferred-username "";
    proxy_set_header x-auth-request-groups "";
    proxy_set_header x-bab-proxy-secret "";
    proxy_set_header x-real-ip $remote_addr;
    proxy_pass http://bab:3000;
}
location /mcp {
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

## Paths to keep public at the proxy

Agents cannot sign in through a browser, so skip the login on these paths (BAB applies its own identity rules there). Clear any identity headers and the proxy secret header on them, so a client cannot send its own.

- `/healthz`, `/readyz`
- `/api/*`
- `/mcp`
- `/instructions/*`
- `/favicon.ico`, `/sw.js`
- Static asset paths served by Next, not listed in `lib/public-paths.ts`: `/branding/*`, `/fonts/*`, `/icons/*`

Everything else, the web pages, stays behind the login.
