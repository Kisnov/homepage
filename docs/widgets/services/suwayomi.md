---
title: Suwayomi
description: Suwayomi Widget Configuration
---

Learn more about [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server).

Allowed fields: ["download", "nondownload", "read", "unread", "downloadedread", "downloadedunread", "nondownloadedread", "nondownloadedunread"]

The widget defaults to the first four above. If more than four fields are provided, only the first 4 are displayed.
Category IDs can be obtained from the url when navigating to it, `?tab={categoryID}`.

If authentication is enabled on the server, set `username`, `password` and `authMode` to match the server's `authMode` setting:

- `basic_auth` (default): sends the credentials as HTTP Basic Auth.
- `simple_login`: logs in through the server's login page and reuses the session cookie.
- `ui_login`: logs in through the GraphQL `login` mutation and sends the returned access token, renewing it with the refresh token when it expires.

```yaml
widget:
  type: suwayomi
  url: http://suwayomi.host.or.ip
  username: username #optional
  password: password #optional
  authMode: ui_login #optional, one of basic_auth (default), simple_login or ui_login
  category: 0 #optional, defaults to all categories
```
