import { beforeEach, describe, expect, it, vi } from "vitest";

import createMockRes from "test-utils/create-mock-res";

const { httpProxy, getServiceWidget, logger, cache } = vi.hoisted(() => {
  const store = new Map();
  return {
    httpProxy: vi.fn(),
    getServiceWidget: vi.fn(),
    logger: { debug: vi.fn(), error: vi.fn() },
    cache: {
      get: vi.fn((key) => store.get(key)),
      put: vi.fn((key, value) => store.set(key, value)),
      del: vi.fn((key) => store.delete(key)),
      clear: () => store.clear(),
    },
  };
});

vi.mock("memory-cache", () => ({
  default: cache,
}));

vi.mock("utils/logger", () => ({
  default: () => logger,
}));
vi.mock("utils/config/service-helpers", () => ({
  default: getServiceWidget,
}));
vi.mock("utils/proxy/http", () => ({
  httpProxy,
}));
vi.mock("widgets/widgets", () => ({
  default: {
    suwayomi: {
      api: "{url}/graphql",
    },
  },
}));

import suwayomiProxyHandler from "./proxy";

describe("widgets/suwayomi/proxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
  });

  const req = { query: { group: "g", service: "svc", endpoint: "graphql", index: "0" } };
  const countsResponse = () => [
    200,
    "application/json",
    Buffer.from(JSON.stringify({ data: { download: { totalCount: 2 }, unread: { totalCount: 5 } } })),
  ];
  const unauthorizedResponse = () => [
    200,
    "application/json",
    Buffer.from(JSON.stringify({ errors: [{ message: "Unauthorized\r\n\r\nstack" }], data: null })),
  ];

  it("returns extracted counts from GraphQL response (no category)", async () => {
    getServiceWidget.mockResolvedValue({ type: "suwayomi", url: "http://su", fields: ["download", "unread"] });

    httpProxy.mockResolvedValueOnce([
      200,
      "application/json",
      Buffer.from(JSON.stringify({ data: { download: { totalCount: 2 }, unread: { totalCount: 5 } } })),
    ]);

    const req = { query: { group: "g", service: "svc", endpoint: "graphql", index: "0" } };
    const res = createMockRes();

    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      { count: 2, label: "suwayomi.download" },
      { count: 5, label: "suwayomi.unread" },
    ]);
  });

  it("returns 401 when credentials are invalid", async () => {
    getServiceWidget.mockResolvedValue({ type: "suwayomi", url: "http://su", username: "u", password: "p" });
    httpProxy.mockResolvedValueOnce([401, "application/json", Buffer.from("{}")]);

    const req = { query: { group: "g", service: "svc", endpoint: "graphql", index: "0" } };
    const res = createMockRes();

    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body.error.message).toContain("unauthorized");
  });

  it("sends basic auth credentials by default", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "p",
      fields: ["download", "unread"],
    });
    httpProxy.mockResolvedValueOnce(countsResponse());

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(httpProxy.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("rejects an unknown authMode", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "p",
      authMode: "x",
    });

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(400);
    expect(httpProxy).not.toHaveBeenCalled();
  });

  it("logs in with the login mutation and uses the access token for ui_login", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "p",
      authMode: "UI_LOGIN",
      fields: ["download", "unread"],
    });
    httpProxy
      .mockResolvedValueOnce([
        200,
        "application/json",
        Buffer.from(JSON.stringify({ data: { login: { accessToken: "access", refreshToken: "refresh" } } })),
      ])
      .mockResolvedValueOnce(countsResponse())
      .mockResolvedValueOnce(countsResponse());

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([
      { count: 2, label: "suwayomi.download" },
      { count: 5, label: "suwayomi.unread" },
    ]);
    const loginBody = JSON.parse(httpProxy.mock.calls[0][1].body);
    expect(loginBody.operationName).toBe("Login");
    expect(loginBody.variables).toEqual({ username: "u", password: "p" });
    expect(httpProxy.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(httpProxy.mock.calls[1][1].headers.Authorization).toBe("Bearer access");

    // the cached token is reused without logging in again
    await suwayomiProxyHandler(req, createMockRes());
    expect(httpProxy).toHaveBeenCalledTimes(3);
    expect(httpProxy.mock.calls[2][1].headers.Authorization).toBe("Bearer access");
  });

  it("refreshes an expired access token for ui_login", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "p",
      authMode: "ui_login",
      fields: ["download", "unread"],
    });
    cache.put("suwayomiProxyHandler__accessToken.g.svc.0", "expired");
    cache.put("suwayomiProxyHandler__refreshToken.g.svc.0", "refresh");
    httpProxy
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce([
        200,
        "application/json",
        Buffer.from(JSON.stringify({ data: { refreshToken: { accessToken: "fresh" } } })),
      ])
      .mockResolvedValueOnce(countsResponse());

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(httpProxy.mock.calls[1][1].body).variables).toEqual({ refreshToken: "refresh" });
    expect(httpProxy.mock.calls[2][1].headers.Authorization).toBe("Bearer fresh");
  });

  it("returns 401 when the ui_login credentials are rejected", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "bad",
      authMode: "ui_login",
    });
    httpProxy.mockResolvedValueOnce([
      200,
      "application/json",
      Buffer.from(JSON.stringify({ errors: [{ message: "Incorrect username or password." }], data: null })),
    ]);

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(httpProxy).toHaveBeenCalledTimes(1);
  });

  it("submits the login form for simple_login and retries the query", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "p",
      authMode: "simple_login",
      fields: ["download", "unread"],
    });
    httpProxy
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce([
        200,
        "text/html",
        Buffer.from('<form><input type="hidden" name="csrf-token" value="csrf123"/></form>'),
      ])
      .mockResolvedValueOnce([303, "text/html", Buffer.from("")])
      .mockResolvedValueOnce(countsResponse());

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(httpProxy.mock.calls[1][0].toString()).toBe("http://su/login.html");
    const [loginUrl, loginParams] = httpProxy.mock.calls[2];
    expect(loginUrl.toString()).toBe("http://su/login.html");
    expect(loginParams.method).toBe("POST");
    expect(loginParams.followRedirects).toBe(false);
    expect(Object.fromEntries(new URLSearchParams(loginParams.body))).toEqual({
      user: "u",
      pass: "p",
      "csrf-token": "csrf123",
    });
    expect(httpProxy.mock.calls[3][1].headers.Authorization).toBeUndefined();
  });

  it("returns 401 when the simple_login form rejects the credentials", async () => {
    getServiceWidget.mockResolvedValue({
      type: "suwayomi",
      url: "http://su",
      username: "u",
      password: "bad",
      authMode: "simple_login",
    });
    httpProxy
      .mockResolvedValueOnce(unauthorizedResponse())
      .mockResolvedValueOnce([200, "text/html", Buffer.from('<input name="csrf-token" value="csrf123"/>')])
      .mockResolvedValueOnce([200, "text/html", Buffer.from("login failed")]);

    const res = createMockRes();
    await suwayomiProxyHandler(req, res);

    expect(res.statusCode).toBe(401);
    expect(httpProxy).toHaveBeenCalledTimes(3);
  });
});
