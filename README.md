# Reqvik

A Chrome extension for tab-scoped request redirects and header overrides.

Use it to test reverse-proxy configurations locally or in development: redirect requests for a hard-coded production host (such as `www.example.com`) to a local proxy, and adjust request headers without changing the application. This makes proxy changes easier for both developers and non-technical testers to verify.

## Development

```sh
pnpm install
pnpm build
```

Load `dist` as an unpacked extension in Chrome.
