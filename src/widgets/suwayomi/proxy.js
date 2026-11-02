import cache from "memory-cache";

import getServiceWidget from "utils/config/service-helpers";
import createLogger from "utils/logger";
import { formatApiCall } from "utils/proxy/api-helpers";
import { httpProxy } from "utils/proxy/http";
import widgets from "widgets/widgets";

const proxyName = "suwayomiProxyHandler";
const logger = createLogger(proxyName);
const accessTokenCacheKey = `${proxyName}__accessToken`;
const refreshTokenCacheKey = `${proxyName}__refreshToken`;

// Suwayomi's `authMode` server setting. NONE needs no credentials.
const AUTH_MODES = {
  basic: "basic_auth",
  basic_auth: "basic_auth",
  simple: "simple_login",
  simple_login: "simple_login",
  ui: "ui_login",
  ui_login: "ui_login",
};

const countsToExtract = {
  download: {
    condition: (c) => c.isDownloaded,
    gqlCondition: "isDownloaded: true",
  },
  nondownload: {
    condition: (c) => !c.isDownloaded,
    gqlCondition: "isDownloaded: false",
  },
  read: {
    condition: (c) => c.isRead,
    gqlCondition: "isRead: true",
  },
  unread: {
    condition: (c) => !c.isRead,
    gqlCondition: "isRead: false",
  },
  downloadedread: {
    condition: (c) => c.isDownloaded && c.isRead,
    gqlCondition: "isDownloaded: true, isRead: true",
  },
  downloadedunread: {
    condition: (c) => c.isDownloaded && !c.isRead,
    gqlCondition: "isDownloaded: true, isRead: false",
  },
  nondownloadedread: {
    condition: (c) => !c.isDownloaded && c.isRead,
    gqlCondition: "isDownloaded: false, isRead: true",
  },
  nondownloadedunread: {
    condition: (c) => !c.isDownloaded && !c.isRead,
    gqlCondition: "isDownloaded: false, isRead: false",
  },
};

function makeBody(fields, category = "all") {
  if (Number.isNaN(Number(category))) {
    let query = "";
    fields.forEach((field) => {
      query += `
      ${field}: chapters(
        condition: {${countsToExtract[field].gqlCondition}}
        filter: {inLibrary: {equalTo: true}}
      ) {
        totalCount
      }`;
    });
    return JSON.stringify({
      operationName: "Counts",
      query: `
      query Counts {
        ${query}
      }`,
    });
  }

  return JSON.stringify({
    operationName: "category",
    query: `
    query category($id: Int!) {
      category(id: $id) {
        # name
        mangas {
          nodes {
            chapters {
              nodes {
                isRead
                isDownloaded
              }
            }
          }
        }
      }
    }`,
    variables: {
      id: Number(category),
    },
  });
}

function extractCounts(responseJSON, fields) {
  if (!("category" in responseJSON.data)) {
    return fields.map((field) => ({
      count: responseJSON.data[field].totalCount,
      label: `suwayomi.${field}`,
    }));
  }
  const tmp = responseJSON.data.category.mangas.nodes.reduce(
    (accumulator, manga) => {
      manga.chapters.nodes.forEach((chapter) => {
        fields.forEach((field, i) => {
          if (countsToExtract[field].condition(chapter)) {
            accumulator[i] += 1;
          }
        });
      });
      return accumulator;
    },
    [0, 0, 0, 0],
  );
  return fields.map((field, i) => ({
    count: tmp[i],
    label: `suwayomi.${field}`,
  }));
}

function getAuthMode(widget) {
  if (!widget.username || !widget.password) return "none";
  const configured = String(widget.authMode ?? "basic_auth")
    .trim()
    .toLowerCase()
    .replace(/[-\s]/g, "_");
  return AUTH_MODES[configured] ?? null;
}

function parseJSON(data) {
  if (!Buffer.isBuffer(data) && typeof data !== "string") return null;
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

// Suwayomi answers GraphQL requests from a logged-out client with HTTP 200 and an "Unauthorized" error
function isUnauthorized(status, json) {
  if (status === 401) return true;
  return Boolean(json?.errors?.some((error) => String(error?.message ?? "").startsWith("Unauthorized")));
}

async function graphqlRequest(url, body, extraHeaders = {}) {
  const [status, contentType, data] = await httpProxy(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
  return { status, contentType, data, json: parseJSON(data) };
}

// UI_LOGIN: obtain a JWT through the `login` mutation, renewing it through `refreshToken` once it expires
async function uiLogin(url, widget, cacheKey) {
  const { json } = await graphqlRequest(
    url,
    JSON.stringify({
      operationName: "Login",
      query: `
      mutation Login($username: String!, $password: String!) {
        login(input: { username: $username, password: $password }) {
          accessToken
          refreshToken
        }
      }`,
      variables: { username: widget.username, password: widget.password },
    }),
  );

  const tokens = json?.data?.login;
  if (!tokens?.accessToken) {
    logger.error(
      "Unable to log in to Suwayomi: %s",
      json?.errors?.[0]?.message?.split("\r\n")[0] ?? "no token returned",
    );
    return null;
  }

  cache.put(`${accessTokenCacheKey}.${cacheKey}`, tokens.accessToken);
  cache.put(`${refreshTokenCacheKey}.${cacheKey}`, tokens.refreshToken);
  return tokens.accessToken;
}

async function uiRefresh(url, cacheKey) {
  const refreshToken = cache.get(`${refreshTokenCacheKey}.${cacheKey}`);
  if (!refreshToken) return null;

  const { json } = await graphqlRequest(
    url,
    JSON.stringify({
      operationName: "RefreshToken",
      query: `
      mutation RefreshToken($refreshToken: String!) {
        refreshToken(input: { refreshToken: $refreshToken }) {
          accessToken
        }
      }`,
      variables: { refreshToken },
    }),
  );

  const accessToken = json?.data?.refreshToken?.accessToken;
  if (!accessToken) {
    logger.debug("Suwayomi refresh token was rejected, logging in again");
    cache.del(`${refreshTokenCacheKey}.${cacheKey}`);
    return null;
  }

  cache.put(`${accessTokenCacheKey}.${cacheKey}`, accessToken);
  return accessToken;
}

async function uiLoginRequest(url, body, widget, cacheKey) {
  let accessToken = cache.get(`${accessTokenCacheKey}.${cacheKey}`);
  let renewed = false;
  if (!accessToken) {
    accessToken = (await uiRefresh(url, cacheKey)) ?? (await uiLogin(url, widget, cacheKey));
    renewed = true;
  }
  if (!accessToken) return { status: 401, json: null };

  let response = await graphqlRequest(url, body, { Authorization: `Bearer ${accessToken}` });
  if (!renewed && isUnauthorized(response.status, response.json)) {
    logger.debug("Suwayomi rejected the access token, renewing it");
    cache.del(`${accessTokenCacheKey}.${cacheKey}`);
    accessToken = (await uiRefresh(url, cacheKey)) ?? (await uiLogin(url, widget, cacheKey));
    if (!accessToken) return { status: 401, json: null };
    response = await graphqlRequest(url, body, { Authorization: `Bearer ${accessToken}` });
  }
  return response;
}

// SIMPLE_LOGIN: submit the server's login form, the session cookie is kept by the proxy's cookie jar
async function simpleLogin(widget) {
  const loginUrl = new URL(formatApiCall("{url}/login.html", widget));

  const [pageStatus, , page] = await httpProxy(loginUrl, { method: "GET", headers: { Accept: "text/html" } });
  const csrfToken = Buffer.isBuffer(page) ? page.toString().match(/name="csrf-token"\s+value="([^"]+)"/)?.[1] : null;
  if (pageStatus !== 200 || !csrfToken) {
    logger.error("Unable to load the Suwayomi login form (status %d)", pageStatus);
    return false;
  }

  const [status] = await httpProxy(loginUrl, {
    method: "POST",
    body: new URLSearchParams({ user: widget.username, pass: widget.password, "csrf-token": csrfToken }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    // a successful login answers 303 and sets the session cookie, the redirect target is not needed
    followRedirects: false,
  });

  if (status !== 303) {
    logger.error("Unable to log in to Suwayomi, username or password is incorrect (status %d)", status);
    return false;
  }
  return true;
}

async function simpleLoginRequest(url, body, widget) {
  let response = await graphqlRequest(url, body);
  if (isUnauthorized(response.status, response.json)) {
    logger.debug("Suwayomi session is missing or expired, logging in");
    if (!(await simpleLogin(widget))) return { status: 401, json: null };
    response = await graphqlRequest(url, body);
  }
  return response;
}

export default async function suwayomiProxyHandler(req, res) {
  const { group, service, endpoint, index } = req.query;

  if (!group || !service) {
    logger.debug("Invalid or missing service '%s' or group '%s'", service, group);
    return res.status(400).json({ error: "Invalid proxy service type" });
  }

  const widget = await getServiceWidget(group, service, index);

  if (!widget) {
    logger.debug("Invalid or missing widget for service '%s' in group '%s'", service, group);
    return res.status(400).json({ error: "Invalid proxy service type" });
  }

  const authMode = getAuthMode(widget);
  if (!authMode) {
    logger.error("Invalid authMode '%s' for service '%s' in group '%s'", widget.authMode, service, group);
    return res.status(400).send({
      error: { message: `Invalid authMode '${widget.authMode}', expected basic_auth, simple_login or ui_login.` },
    });
  }

  if (!widget.fields || widget.fields.length === 0) {
    widget.fields = ["download", "nondownload", "read", "unread"];
  } else if (widget.fields.length > 4) {
    widget.fields = widget.fields.slice(0, 4);
  }

  const url = new URL(formatApiCall(widgets[widget.type].api, { endpoint, ...widget }));

  const body = makeBody(widget.fields, widget.category);

  let response;
  if (authMode === "ui_login") {
    response = await uiLoginRequest(url, body, widget, [group, service, index ?? 0].join("."));
  } else if (authMode === "simple_login") {
    response = await simpleLoginRequest(url, body, widget);
  } else {
    const headers = {};
    if (authMode === "basic_auth") {
      headers.Authorization = `Basic ${Buffer.from(`${widget.username}:${widget.password}`).toString("base64")}`;
    }
    response = await graphqlRequest(url, body, headers);
  }

  const { status, contentType, data, json } = response;

  if (isUnauthorized(status, json)) {
    logger.error("Invalid or missing username or password for service '%s' in group '%s'", service, group);
    return res.status(401).send({ error: { message: "401: unauthorized, username or password is incorrect." } });
  }

  if (status !== 200 || !json?.data) {
    logger.error(
      "Error getting data from Suwayomi for service '%s' in group '%s': %d.  Data: %s",
      service,
      group,
      status,
      data,
    );
    return res
      .status(status === 200 ? 500 : status)
      .send({ error: { message: "Error getting data from Suwayomi", data: json?.errors?.[0]?.message ?? data } });
  }

  const returnData = extractCounts(json, widget.fields);

  if (contentType) res.setHeader("Content-Type", contentType);
  return res.status(status).send(returnData);
}
