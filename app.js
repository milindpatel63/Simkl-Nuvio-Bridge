"use strict";

const TRAKT_API = "https://api.trakt.tv";
const NUVIO_BASE = "https://dpyhjjcoabcglfmgecug.supabase.co";
const NUVIO_KEY = "sb_publishable_zcNkgqGJjBtj8GoRlMvl9A_zkdmXhf5";
const APP_CONFIG = globalThis.NUVIO_TRAKT_BRIDGE_CONFIG || {};
const PREFS_KEY = "nuvio-trakt-bridge:prefs:v1";
const SESSION_KEY = "nuvio-trakt-bridge:session:v1";
const LEGACY_STORAGE_KEY = "nuvio-trakt-bridge:v1";

const $ = (selector) => document.querySelector(selector);
const dom = {
  traktStatus: $("#trakt-status"),
  nuvioStatus: $("#nuvio-status"),
  startTraktLogin: $("#start-trakt-login"),
  logoutTrakt: $("#logout-trakt"),
  nuvioEmail: $("#nuvio-email"),
  nuvioPassword: $("#nuvio-password"),
  loginNuvio: $("#login-nuvio"),
  logoutNuvio: $("#logout-nuvio"),
  profileSelect: $("#profile-select"),
  syncHistory: $("#sync-history"),
  syncProgress: $("#sync-progress"),
  syncWatchlist: $("#sync-watchlist"),
  syncCollection: $("#sync-collection"),
  previewSync: $("#preview-sync"),
  previewPager: $("#preview-pager"),
  previewPrev: $("#preview-prev"),
  previewNext: $("#preview-next"),
  previewPageInfo: $("#preview-page-info"),
  runSync: $("#run-sync"),
  copyLog: $("#copy-log"),
  log: $("#log"),
  previewTable: $("#preview-table"),
  statHistory: $("#stat-history"),
  statProgress: $("#stat-progress"),
  statLibrary: $("#stat-library"),
  statSkipped: $("#stat-skipped"),
  toasts: $("#toasts"),
  toastTemplate: $("#toast-template"),
};

let state = loadState();
let lastPlan = null;
let previewRows = [];
let previewPage = 1;
let traktPending = false;
let pendingTraktState = null;
let pendingTraktClientId = "";
let traktBroadcastChannel = null;
const PREVIEW_PAGE_SIZE = 50;
const EPISODE_REMAP_META_TIMEOUT_MS = 3000;
const EPISODE_REMAP_TRAKT_TIMEOUT_MS = 4500;
const EPISODE_REMAP_TOTAL_BUDGET_MS = 30000;
const EPISODE_REMAP_FALLBACK_LOG_LIMIT = 2;
let episodeMappingContextPromise = null;
let episodeMappingContextKey = "";
const addonManifestCache = new Map();
const addonMetaCache = new Map();
const addonEpisodeCache = new Map();
const traktEpisodeCache = new Map();
const episodeMappingCache = new Map();
const normalizedEpisodeTitleCache = new Map();

function defaultState() {
  return {
    trakt: {
      token: null,
      clientId: "",
    },
    nuvio: {
      session: null,
      profiles: [],
      profileId: 1,
    },
    options: {
      syncHistory: true,
      syncProgress: true,
      syncWatchlist: false,
      syncCollection: false,
      estimateDuration: true,
      keepFinishedProgress: false,
      maxPages: 0,
      idRemaps: "",
    },
  };
}

function loadState() {
  clearStoredBridgeData();
  return defaultState();
}

function saveState() {
  clearStoredBridgeData();
}

function clearStoredBridgeData() {
  try {
    localStorage.removeItem(PREFS_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {}
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
}

function hydrateForm() {
  dom.syncHistory.checked = Boolean(state.options.syncHistory);
  dom.syncProgress.checked = Boolean(state.options.syncProgress);
  dom.syncWatchlist.checked = Boolean(state.options.syncWatchlist);
  dom.syncCollection.checked = Boolean(state.options.syncCollection);
  renderProfiles();
  updateAuthStatus();
  clearLog();
  logLine("Ready. Connect Trakt and Nuvio, then preview before syncing.");
}

function readOptions() {
  state.options = {
    syncHistory: dom.syncHistory.checked,
    syncProgress: dom.syncProgress.checked,
    syncWatchlist: dom.syncWatchlist.checked,
    syncCollection: dom.syncCollection.checked,
    estimateDuration: true,
    keepFinishedProgress: false,
    maxPages: 0,
    idRemaps: "",
  };
  state.nuvio.profileId = Number(dom.profileSelect.value || state.nuvio.profileId || 1);
  saveState();
  return state.options;
}

function updateAuthStatus() {
  const traktConnected = Boolean(state.trakt.token?.access_token);
  const nuvioConnected = Boolean(state.nuvio.session?.access_token);

  dom.traktStatus.textContent = traktConnected ? "Trakt connected" : "Trakt disconnected";
  dom.traktStatus.classList.toggle("is-connected", traktConnected);
  dom.nuvioStatus.textContent = nuvioConnected ? "Nuvio connected" : "Nuvio disconnected";
  dom.nuvioStatus.classList.toggle("is-connected", nuvioConnected);
  updateAuthButtons(traktConnected, nuvioConnected);
  updateSyncActionButtons(traktConnected, nuvioConnected);
}

function updateAuthButtons(traktConnected, nuvioConnected) {
  updateConnectedButton(dom.startTraktLogin, traktConnected, "Disconnect Trakt");
  updateConnectedButton(dom.loginNuvio, nuvioConnected, "Disconnect");
}

function updateSyncActionButtons(traktConnected, nuvioConnected) {
  const ready = traktConnected && nuvioConnected;
  dom.previewSync.disabled = !ready;
  dom.runSync.disabled = !ready;
}

function updateConnectedButton(button, connected, connectedLabel) {
  if (!button) return;
  rememberButtonLabel(button);
  button.classList.remove("is-connected");
  button.classList.toggle("is-disconnect", connected);
  if (connected) {
    button.textContent = connectedLabel;
    button.disabled = false;
    button.setAttribute("aria-pressed", "true");
    return;
  }
  button.removeAttribute("aria-pressed");
  if (!(button === dom.startTraktLogin && traktPending)) {
    restoreButtonLabel(button);
  }
}

function browserRedirectUri() {
  if (!globalThis.location || location.protocol === "file:") {
    return "http://127.0.0.1:4173/";
  }
  return `${location.origin}${location.pathname}`;
}

function traktLoginUrlEndpoint() {
  return String(APP_CONFIG.traktLoginUrlEndpoint || "/api/trakt/login-url").trim();
}

function traktRefreshEndpoint() {
  return String(APP_CONFIG.traktRefreshEndpoint || "/api/trakt/refresh").trim();
}

function traktCallbackOrigin() {
  return String(APP_CONFIG.traktCallbackOrigin || location.origin || "").trim();
}

function allowedTraktOrigins() {
  return [...new Set([location.origin, traktCallbackOrigin()].filter(Boolean))];
}

function renderProfiles() {
  const profiles = state.nuvio.profiles?.length
    ? state.nuvio.profiles
    : [{ profile_index: 1, name: "Profile 1" }];
  dom.profileSelect.innerHTML = profiles
    .map((profile) => {
      const id = Number(profile.profile_index || profile.id || 1);
      const label = escapeHtml(profile.name || `Profile ${id}`);
      const selected = Number(state.nuvio.profileId || 1) === id ? "selected" : "";
      return `<option value="${id}" ${selected}>${label}</option>`;
    })
    .join("");
}

function setBusy(isBusy) {
  const traktConnected = Boolean(state.trakt.token?.access_token);
  const nuvioConnected = Boolean(state.nuvio.session?.access_token);
  const syncReady = traktConnected && nuvioConnected;
  [
    dom.startTraktLogin,
    dom.loginNuvio,
    dom.previewSync,
    dom.runSync,
  ].forEach((button) => {
    if (!button) return;
    button.disabled = isBusy
      || (button === dom.startTraktLogin && traktPending)
      || ((button === dom.previewSync || button === dom.runSync) && !syncReady);
  });
}

function rememberButtonLabel(button) {
  if (button && !button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent.trim();
  }
}

function setButtonLabel(button, label) {
  if (!button || !label) return;
  rememberButtonLabel(button);
  button.textContent = label;
}

function restoreButtonLabel(button) {
  if (button?.dataset.defaultLabel) {
    button.textContent = button.dataset.defaultLabel;
  }
}

function flashButtonLabel(button, label) {
  if (!button || !label) return;
  rememberButtonLabel(button);
  button.textContent = label;
  window.setTimeout(() => restoreButtonLabel(button), 1400);
}

function clearLog() {
  dom.log.textContent = "";
}

function logLine(message) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  dom.log.textContent += `[${time}] ${message}\n`;
  dom.log.scrollTop = dom.log.scrollHeight;
}

function toast(message) {
  const node = dom.toastTemplate.content.firstElementChild.cloneNode(true);
  node.textContent = message;
  dom.toasts.appendChild(node);
  window.setTimeout(() => node.remove(), 4200);
}

function updateStats(plan) {
  dom.statHistory.textContent = String(plan?.history?.length || 0);
  dom.statProgress.textContent = String(plan?.progress?.length || 0);
  dom.statLibrary.textContent = String(plan?.library?.length || 0);
  dom.statSkipped.textContent = String((plan?.skipped?.length || 0) + (plan?.fallbackIds || 0));
}

function previewRowsForPlan(plan) {
  if (!plan) return [];
  return [
    ...plan.history.map((item) => ({
      type: item.season ? "watched episode" : "watched movie",
      title: item.title || "Untitled",
      id: item.content_id,
      when: item.watched_at,
    })),
    ...plan.progress.map((item) => ({
      type: item.season ? "progress episode" : "progress movie",
      title: item._title || item.content_id,
      id: item.content_id,
      when: item.last_watched,
    })),
    ...plan.library.map((item) => ({
      type: `${item._source || "library"} item`,
      title: item.name || item.content_id,
      id: item.content_id,
      when: item.added_at,
    })),
  ];
}

function renderPreview(plan, page = 1) {
  previewRows = previewRowsForPlan(plan);
  renderPreviewPage(page);
}

function renderPreviewPage(page = previewPage) {
  const pageCount = Math.max(1, Math.ceil(previewRows.length / PREVIEW_PAGE_SIZE));
  previewPage = clamp(Number(page) || 1, 1, pageCount);

  if (!previewRows.length) {
    dom.previewTable.innerHTML = '<tr><td colspan="4">No mapped items yet.</td></tr>';
    updatePreviewPager(0);
    return;
  }

  const start = (previewPage - 1) * PREVIEW_PAGE_SIZE;
  const rows = previewRows.slice(start, start + PREVIEW_PAGE_SIZE);

  dom.previewTable.innerHTML = rows
    .map((row) => {
      return `<tr>
        <td>${escapeHtml(row.type)}</td>
        <td>${escapeHtml(row.title)}</td>
        <td><code>${escapeHtml(row.id)}</code></td>
        <td>${escapeHtml(formatMsDate(row.when))}</td>
      </tr>`;
    })
    .join("");
  updatePreviewPager(pageCount);
}

function updatePreviewPager(pageCount) {
  if (!dom.previewPager) return;
  const hasPages = previewRows.length > PREVIEW_PAGE_SIZE;
  dom.previewPager.hidden = !hasPages;
  if (!hasPages) return;

  dom.previewPageInfo.textContent = `Page ${previewPage} of ${pageCount} - ${previewRows.length} items`;
  dom.previewPrev.disabled = previewPage <= 1;
  dom.previewNext.disabled = previewPage >= pageCount;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === "object" && data
      ? data.error_description || data.msg || data.message || data.error || JSON.stringify(data)
      : data || response.statusText;
    const error = new Error(`${response.status} ${detail}`);
    error.status = response.status;
    error.body = data;
    error.headers = response.headers;
    throw error;
  }

  return { data, headers: response.headers, status: response.status };
}

async function startTraktPopupLogin() {
  readOptions();
  if (traktPending) {
    return;
  }

  traktPending = true;
  dom.startTraktLogin.disabled = true;
  setButtonLabel(dom.startTraktLogin, "Opening Trakt...");
  logLine("Opening Trakt sign in.");
  try {
    const { data } = await requestJson(traktLoginUrlEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ return_origin: location.origin }),
    });
    if (!data?.url) {
      throw new Error(resolveRemoteError(data) || "The Trakt login endpoint did not return a URL.");
    }
    pendingTraktState = data.state || null;
    pendingTraktClientId = normalizeTraktClientId(data.client_id || data.clientId)
      || extractTraktClientIdFromUrl(data.url);
    if (!pendingTraktClientId) {
      throw new Error("The Trakt login endpoint did not return a valid app client id.");
    }
    const popup = window.open(data.url, "trakt-sign-in", "width=600,height=780");
    if (!popup) {
      throw new Error("Allow pop-ups for this site, then click Connect Trakt again.");
    }
    popup.focus();
    setButtonLabel(dom.startTraktLogin, "Waiting for Trakt...");
    const popupWatcher = window.setInterval(() => {
      if (!traktPending) {
        window.clearInterval(popupWatcher);
        return;
      }
      if (popup.closed) {
        window.clearInterval(popupWatcher);
        traktPending = false;
        pendingTraktState = null;
        pendingTraktClientId = "";
        restoreButtonLabel(dom.startTraktLogin);
        setBusy(false);
        logLine("Trakt sign in window closed before finishing.");
      }
    }, 700);
    logLine("Approve access in the Trakt popup. This page will update automatically.");
  } catch (error) {
    traktPending = false;
    dom.startTraktLogin.disabled = false;
    restoreButtonLabel(dom.startTraktLogin);
    throw new Error(loginEndpointError(error));
  }
}

function normalizeTraktToken(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type || "bearer",
    expires_in: token.expires_in || 7776000,
    scope: token.scope || "",
    created_at: token.created_at || Math.floor(Date.now() / 1000),
  };
}

function normalizeTraktOauthPayload(rawPayload) {
  if (rawPayload == null) return null;
  let data = rawPayload;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  if (data.source === "trakt-oauth") {
    data.client_id = data.client_id || data.clientId || "";
    if (!data.tokens && (data.access_token || data.refresh_token)) {
      data.tokens = {
        access_token: data.access_token || data.accessToken || "",
        refresh_token: data.refresh_token || data.refreshToken || "",
        expires_in: data.expires_in || data.expiresIn,
        token_type: data.token_type || data.tokenType,
        scope: data.scope,
      };
    }
    return data;
  }
  const type = typeof data.type === "string" ? data.type.toUpperCase() : "";
  if (type === "TRAKT_AUTH_SUCCESS") {
    return {
      source: "trakt-oauth",
      status: "success",
      client_id: data.client_id || data.clientId || "",
      tokens: {
        access_token: data.access_token || data.accessToken || "",
        refresh_token: data.refresh_token || data.refreshToken || "",
        expires_in: data.expires_in || data.expiresIn,
        token_type: data.token_type || data.tokenType,
        scope: data.scope,
      },
    };
  }
  if (type === "TRAKT_AUTH_ERROR") {
    return {
      source: "trakt-oauth",
      status: "error",
      client_id: data.client_id || data.clientId || "",
      error: data.error || data.message || "trakt_error",
      error_description: data.error_description || data.description || "",
    };
  }
  return null;
}

function handleTraktOauthPayload(rawPayload, origin = "") {
  const payload = normalizeTraktOauthPayload(rawPayload);
  if (!payload || payload.source !== "trakt-oauth") return;
  if (origin && !allowedTraktOrigins().includes(origin)) return;

  traktPending = false;
  restoreButtonLabel(dom.startTraktLogin);
  dom.startTraktLogin.disabled = false;
  if (pendingTraktState && payload.state !== pendingTraktState) {
    pendingTraktState = null;
    pendingTraktClientId = "";
    logLine("Trakt sign in failed: authorization state did not match.");
    toast("Trakt sign in failed. Try connecting again.");
    return;
  }
  if (payload.status === "success" && payload.tokens?.access_token) {
    const clientId = normalizeTraktClientId(payload.client_id || payload.clientId)
      || pendingTraktClientId
      || normalizeTraktClientId(state.trakt.clientId);
    if (!clientId) {
      logLine("Trakt sign in failed: missing app client id from the login endpoint.");
      toast("Trakt sign in failed. The login endpoint is missing its app client id.");
      return;
    }
    state.trakt.token = normalizeTraktToken(payload.tokens);
    state.trakt.clientId = clientId;
    pendingTraktState = null;
    pendingTraktClientId = "";
    saveState();
    updateAuthStatus();
    logLine("Trakt connected.");
    toast("Trakt connected.");
    return;
  }
  const message = payload.error_description || payload.error || "Trakt rejected the sign in request.";
  pendingTraktState = null;
  pendingTraktClientId = "";
  logLine(`Trakt sign in failed: ${message}`);
  toast(message);
}

function resolveRemoteError(payload) {
  if (!payload) return null;
  if (typeof payload === "string") return payload;
  if (typeof payload.detail === "string") return payload.detail;
  if (payload.detail && typeof payload.detail === "object") {
    return payload.detail.description || payload.detail.error || null;
  }
  return payload.message || payload.error_description || payload.error || null;
}

function loginEndpointError(error) {
  if (error?.status === 404) {
    return "The Trakt login endpoint is missing. Deploy /api/trakt/login-url like the reference site, then try again.";
  }
  const remote = resolveRemoteError(error?.body);
  if (remote) {
    return remote;
  }
  return error?.message || "Unable to start Trakt sign in.";
}

async function ensureTraktAccessToken() {
  if (!state.trakt.token?.access_token) {
    throw new Error("Connect Trakt first.");
  }

  const createdAt = Number(state.trakt.token.created_at || 0);
  const expiresIn = Number(state.trakt.token.expires_in || 0);
  const expiresAt = createdAt + expiresIn;
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt && now < expiresAt - 90) {
    return state.trakt.token.access_token;
  }

  if (!state.trakt.token.refresh_token) {
    throw new Error("Trakt token expired and no refresh token was saved. Reconnect Trakt.");
  }
  logLine("Refreshing Trakt token.");
  const data = await refreshTraktToken(state.trakt.token.refresh_token);

  const clientId = state.trakt.clientId || "";
  state.trakt.token = normalizeTraktToken(data);
  state.trakt.clientId = clientId || normalizeTraktClientId(data.client_id || data.clientId);
  saveState();
  return state.trakt.token.access_token;
}

async function refreshTraktToken(refreshToken) {
  const { data } = await requestJson(traktRefreshEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return data;
}

async function traktRequest(path, params = {}, fetchOptions = {}) {
  const accessToken = await ensureTraktAccessToken();
  const apiKey = normalizeTraktClientId(state.trakt.clientId);
  if (!apiKey) {
    throw new Error("Reconnect Trakt. This authorization session is missing the app client id Trakt requires for API requests.");
  }
  const url = new URL(`${TRAKT_API}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return requestJson(url.toString(), {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": apiKey,
      Authorization: `Bearer ${accessToken}`,
      ...(fetchOptions.headers || {}),
    },
  });
}

async function traktRequestWithTimeout(path, params = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await traktRequest(path, params, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loginNuvio() {
  const email = dom.nuvioEmail.value.trim();
  const password = dom.nuvioPassword.value;
  if (!email || !password) {
    throw new Error("Enter your Nuvio email and password.");
  }

  const endpoint = `${NUVIO_BASE}/auth/v1/token?grant_type=password`;
  logLine("Signing in to Nuvio.");

  const { data } = await requestJson(endpoint, {
    method: "POST",
    headers: {
      apikey: NUVIO_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!data?.access_token) {
    throw new Error("Nuvio did not return an access token. Check whether email confirmation is required, then sign in.");
  }

  state.nuvio.session = normalizeNuvioSession(data);
  clearEpisodeMappingCaches();
  saveState();
  updateAuthStatus();
  await loadNuvioProfiles();
  logLine("Nuvio connected.");
}

async function toggleNuvioConnection() {
  if (state.nuvio.session?.access_token) {
    setButtonLabel(dom.loginNuvio, "Disconnecting...");
    await disconnectNuvio();
    return;
  }
  setButtonLabel(dom.loginNuvio, "Signing in...");
  await loginNuvio();
}

async function toggleTraktConnection() {
  if (state.trakt.token?.access_token) {
    setButtonLabel(dom.startTraktLogin, "Disconnecting...");
    disconnectTrakt();
    return;
  }
  await startTraktPopupLogin();
}

async function ensureNuvioAccessToken() {
  if (!state.nuvio.session?.access_token) {
    throw new Error("Connect Nuvio first.");
  }

  const expiresAt = Number(state.nuvio.session.expires_at || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!expiresAt || now < expiresAt - 90) {
    return state.nuvio.session.access_token;
  }

  if (!state.nuvio.session.refresh_token) {
    throw new Error("Nuvio token expired and no refresh token was saved. Sign in again.");
  }

  logLine("Refreshing Nuvio token.");
  const { data } = await requestJson(`${NUVIO_BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: NUVIO_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: state.nuvio.session.refresh_token }),
  });

  state.nuvio.session = normalizeNuvioSession(data);
  saveState();
  return state.nuvio.session.access_token;
}

function normalizeNuvioSession(session) {
  const now = Math.floor(Date.now() / 1000);
  return {
    ...session,
    expires_at: session.expires_at || (session.expires_in ? now + Number(session.expires_in) : 0),
  };
}

async function nuvioRpc(name, body = {}, auth = true) {
  const headers = {
    apikey: NUVIO_KEY,
    "Content-Type": "application/json",
  };
  if (auth) {
    headers.Authorization = `Bearer ${await ensureNuvioAccessToken()}`;
  }

  const { data } = await requestJson(`${NUVIO_BASE}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  return data;
}

async function loadNuvioProfiles() {
  if (!state.nuvio.session?.access_token) return;
  const profiles = await nuvioRpc("sync_pull_profiles", {});
  state.nuvio.profiles = Array.isArray(profiles) ? profiles : [];
  if (!state.nuvio.profiles.some((profile) => Number(profile.profile_index) === Number(state.nuvio.profileId))) {
    state.nuvio.profileId = Number(state.nuvio.profiles[0]?.profile_index || 1);
  }
  saveState();
  renderProfiles();
}

async function fetchAllTrakt(paths, params, label, options, fetchOptions = {}) {
  const errors = [];
  for (const path of paths) {
    try {
      return await fetchAllTraktPath(path, params, label, options, fetchOptions);
    } catch (error) {
      errors.push(error);
      if (![400, 404, 405].includes(error.status)) {
        throw error;
      }
      logLine(`Trakt endpoint ${path} did not fit (${error.message}); trying fallback if available.`);
    }
  }
  throw errors[errors.length - 1] || new Error(`Unable to fetch ${label}.`);
}

async function fetchAllTraktOptional(paths, params, label, options) {
  try {
    return await fetchAllTrakt(paths, params, label, options);
  } catch (error) {
    logLine(`Skipping ${label}: ${error.message}`);
    return [];
  }
}

async function fetchAllTraktPath(path, params, label, options, fetchOptions = {}) {
  if (fetchOptions.paged === false) {
    const { data } = await traktRequest(path, params);
    const batch = Array.isArray(data) ? data : data ? [data] : [];
    logLine(`Pulled ${batch.length} ${label} from ${path}.`);
    return batch;
  }

  const limit = 1000;
  const configuredMaxPages = Number(options.maxPages);
  const maxPages = Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
    ? configuredMaxPages
    : Number.POSITIVE_INFINITY;
  const all = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, headers } = await traktRequest(path, {
      ...params,
      page,
      limit,
    });
    const batch = Array.isArray(data) ? data : data ? [data] : [];
    all.push(...batch);

    const pageCount = Number(headers.get("x-pagination-page-count") || 0);
    logLine(`Pulled ${batch.length} ${label} from ${path}, page ${page}${pageCount ? `/${pageCount}` : ""}.`);

    if (pageCount && page >= pageCount) break;
    if (batch.length < limit) break;
  }

  return all;
}

async function nuvioRest(path, params = {}) {
  const token = await ensureNuvioAccessToken();
  const url = new URL(`${NUVIO_BASE}/rest/v1/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const { data } = await requestJson(url.toString(), {
    headers: {
      apikey: NUVIO_KEY,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  return data;
}

function clearEpisodeMappingCaches() {
  episodeMappingContextPromise = null;
  episodeMappingContextKey = "";
  addonMetaCache.clear();
  addonEpisodeCache.clear();
  episodeMappingCache.clear();
}

async function prepareEpisodeMapper() {
  if (!state.nuvio.session?.access_token) {
    logLine("Nuvio is not connected, so episode remapping is skipped for this preview.");
    return null;
  }

  try {
    const context = await loadEpisodeMappingContext();
    if (!context.addons.length) {
      logLine("No compatible Nuvio metadata addon was found, so episode remapping is skipped.");
      return null;
    }
    context.disabled = false;
    context.startedAt = 0;
    context.timeoutLogged = false;
    context.metaTimeoutMs = EPISODE_REMAP_META_TIMEOUT_MS;
    context.traktTimeoutMs = EPISODE_REMAP_TRAKT_TIMEOUT_MS;
    context.totalBudgetMs = EPISODE_REMAP_TOTAL_BUDGET_MS;
    context.fallbackStats = {};
    context.fallbackLogCounts = {};
    logLine(`Using Nuvio metadata addon for episode remapping: ${context.addons[0].name}.`);
    logLine(`Episode remapping fallback guard: addon ${Math.round(context.metaTimeoutMs / 1000)}s, Trakt ${Math.round(context.traktTimeoutMs / 1000)}s, total ${Math.round(context.totalBudgetMs / 1000)}s.`);
    return context;
  } catch (error) {
    logLine(`Episode remapping unavailable: ${error.message}`);
    return null;
  }
}

async function loadEpisodeMappingContext() {
  const selectedProfileId = Number(state.nuvio.profileId || 1);
  const profile = state.nuvio.profiles.find((item) => Number(item.profile_index || item.id || 1) === selectedProfileId);
  const effectiveProfileId = selectedProfileId !== 1 && profile?.uses_primary_addons ? 1 : selectedProfileId;
  const key = `${effectiveProfileId}:${state.nuvio.session?.access_token || ""}`;

  if (episodeMappingContextPromise && episodeMappingContextKey === key) {
    return episodeMappingContextPromise;
  }

  episodeMappingContextKey = key;
  episodeMappingContextPromise = pullNuvioMetadataAddons(effectiveProfileId)
    .then((addons) => ({ addons, effectiveProfileId }))
    .catch((error) => {
      episodeMappingContextPromise = null;
      episodeMappingContextKey = "";
      throw error;
    });

  return episodeMappingContextPromise;
}

async function pullNuvioMetadataAddons(profileId) {
  const params = {
    select: "url,name,sort_order,profile_id,enabled",
    profile_id: `eq.${profileId}`,
    order: "sort_order.asc",
  };
  if (state.nuvio.session?.user?.id) {
    params.user_id = `eq.${state.nuvio.session.user.id}`;
  }

  const rows = await nuvioRest("addons", params);
  const sortedRows = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.url && row.enabled !== false)
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0));

  for (const row of sortedRows) {
    const addon = await fetchAddonManifest(row.url, row.name).catch(() => null);
    if (addon && addonHasMetaResource(addon)) {
      return [addon];
    }
  }
  return [];
}

async function fetchAddonManifest(addonUrl, fallbackName) {
  const baseUrl = canonicalizeAddonUrl(addonUrl);
  if (!baseUrl) return null;
  if (addonManifestCache.has(baseUrl)) {
    return addonManifestCache.get(baseUrl);
  }

  const manifest = await fetchJsonUrl(buildAddonResourceUrl(baseUrl, "manifest.json"), 8000);
  const addon = parseAddonManifest(manifest, baseUrl, fallbackName);
  addonManifestCache.set(baseUrl, addon);
  return addon;
}

async function fetchJsonUrl(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function canonicalizeAddonUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const queryIndex = text.indexOf("?");
  const path = queryIndex >= 0 ? text.slice(0, queryIndex) : text;
  const query = queryIndex >= 0 ? text.slice(queryIndex) : "";
  const withoutManifest = path.toLowerCase().endsWith("/manifest.json")
    ? path.slice(0, -"/manifest.json".length)
    : path;
  return `${withoutManifest.replace(/\/+$/, "")}${query}`;
}

function buildAddonResourceUrl(addonUrl, resourcePath) {
  const baseUrl = canonicalizeAddonUrl(addonUrl);
  const queryIndex = baseUrl.indexOf("?");
  const path = queryIndex >= 0 ? baseUrl.slice(0, queryIndex) : baseUrl;
  const query = queryIndex >= 0 ? baseUrl.slice(queryIndex) : "";
  return `${path}/${resourcePath.replace(/^\/+/, "")}${query}`;
}

function buildAddonMetaUrl(addonUrl, type, id) {
  return buildAddonResourceUrl(addonUrl, `meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
}

function parseAddonManifest(manifest, baseUrl, fallbackName) {
  const rawTypes = Array.isArray(manifest?.types)
    ? manifest.types.map((type) => String(type || "").trim()).filter(Boolean)
    : [];
  return {
    baseUrl,
    name: String(manifest?.name || fallbackName || baseUrl),
    rawTypes,
    resources: parseAddonResources(manifest?.resources, rawTypes),
  };
}

function parseAddonResources(resources, fallbackTypes) {
  if (!Array.isArray(resources)) return [];
  return resources.map((resource) => {
    if (typeof resource === "string") {
      return {
        name: resource,
        types: fallbackTypes,
        idPrefixes: [],
      };
    }
    return {
      name: String(resource?.name || "").trim(),
      types: Array.isArray(resource?.types)
        ? resource.types.map((type) => String(type || "").trim()).filter(Boolean)
        : fallbackTypes,
      idPrefixes: Array.isArray(resource?.idPrefixes)
        ? resource.idPrefixes.map((prefix) => String(prefix || "").trim()).filter(Boolean)
        : [],
    };
  }).filter((resource) => resource.name);
}

function addonHasMetaResource(addon) {
  return addon.resources.some((resource) => resource.name.toLowerCase() === "meta");
}

function addonSupportsMetaType(addon, type) {
  const normalizedType = String(type || "").trim().toLowerCase();
  if (!normalizedType) return false;
  return addon.resources.some((resource) => {
    if (resource.name.toLowerCase() !== "meta") return false;
    if (!resource.types.length) return true;
    return resource.types.some((candidate) => candidate.toLowerCase() === normalizedType);
  });
}

function inferCanonicalMetaType(type) {
  const value = String(type || "").toLowerCase();
  if (["series", "show", "tv", "episode"].includes(value)) return "series";
  if (value === "movie") return "movie";
  return value || "series";
}

function selectMetaAddonCandidates(addons, requestedType) {
  const canonicalType = inferCanonicalMetaType(requestedType);
  const candidates = [];
  const seen = new Set();
  const add = (addon, type) => {
    const key = `${addon.baseUrl}|${type}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ addon, type });
    }
  };

  for (const addon of addons) {
    if (addonSupportsMetaType(addon, requestedType)) add(addon, requestedType);
  }
  for (const addon of addons) {
    if (addonSupportsMetaType(addon, canonicalType)) add(addon, canonicalType);
  }
  if (!candidates.length) {
    for (const addon of addons) {
      if (addon.rawTypes.some((type) => type.toLowerCase() === String(requestedType).toLowerCase())) {
        add(addon, requestedType);
      }
    }
  }
  if (!candidates.length) {
    const firstMetaAddon = addons.find(addonHasMetaResource);
    if (firstMetaAddon) add(firstMetaAddon, requestedType);
  }

  return candidates;
}

async function fetchMetaFromAddons(context, type, id) {
  if (!context?.addons?.length || !type || !id) return null;
  for (const { addon, type: candidateType } of selectMetaAddonCandidates(context.addons, type)) {
    const cacheKey = `${addon.baseUrl}|${candidateType}|${id}`;
    let response;
    if (addonMetaCache.has(cacheKey)) {
      response = addonMetaCache.get(cacheKey);
    } else {
      response = await fetchJsonUrl(buildAddonMetaUrl(addon.baseUrl, candidateType, id), context.metaTimeoutMs || EPISODE_REMAP_META_TIMEOUT_MS)
        .catch(() => null);
      addonMetaCache.set(cacheKey, response);
    }
    if (response?.meta) return response.meta;
  }
  return null;
}

async function fetchSeriesMeta(contentId, contentType, context) {
  const typeCandidates = unique([contentType, inferCanonicalMetaType(contentType), "series", "tv"]);
  const idCandidates = unique([
    contentId,
    barePrefixedId(contentId, "tmdb"),
    barePrefixedId(contentId, "trakt"),
  ].filter(Boolean));

  for (const type of typeCandidates) {
    for (const id of idCandidates) {
      const meta = await fetchMetaFromAddons(context, type, id);
      if (Array.isArray(meta?.videos) && meta.videos.length) {
        return meta;
      }
    }
  }
  return null;
}

async function getAddonEpisodes(contentId, contentType, context) {
  const cacheKey = `${context.effectiveProfileId}|${contentType}|${contentId}`;
  if (addonEpisodeCache.has(cacheKey)) return addonEpisodeCache.get(cacheKey);
  const meta = await fetchSeriesMeta(contentId, contentType, context);
  const episodes = mapAddonVideosToEpisodeEntries(meta?.videos || []);
  addonEpisodeCache.set(cacheKey, episodes);
  if (!episodes.length) {
    noteEpisodeRemapFallback(
      context,
      "metadata",
      `addon metadata was unavailable or timed out for ${contentId}; using Trakt numbering for that show.`,
    );
  }
  return episodes;
}

function mapAddonVideosToEpisodeEntries(videos) {
  const seen = new Set();
  return videos
    .map((video) => {
      const season = asNumber(video?.season);
      const episode = asNumber(video?.episode ?? video?.number);
      if (season === null || episode === null || season <= 0 || episode <= 0) return null;
      const videoId = typeof video?.id === "string" && video.id.trim() ? video.id.trim() : null;
      const key = videoId || `${season}:${episode}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        season,
        episode,
        title: video?.title || video?.name || `Episode ${episode}`,
        videoId,
      };
    })
    .filter(Boolean)
    .sort(compareEpisodeEntries);
}

async function getTraktEpisodes(showLookupId, context) {
  if (!showLookupId) return [];
  if (traktEpisodeCache.has(showLookupId)) return traktEpisodeCache.get(showLookupId);
  let data = [];
  try {
    const response = await traktRequestWithTimeout(`/shows/${encodeURIComponent(showLookupId)}/seasons`, {
      extended: "episodes",
    }, context?.traktTimeoutMs || EPISODE_REMAP_TRAKT_TIMEOUT_MS);
    data = response.data;
  } catch {
    noteEpisodeRemapFallback(
      context,
      "trakt",
      `Trakt episode lookup was unavailable or timed out for ${showLookupId}; using Trakt numbering for that show.`,
    );
    traktEpisodeCache.set(showLookupId, []);
    return [];
  }
  const entries = [];
  for (const season of Array.isArray(data) ? data : []) {
    const seasonNumber = asNumber(season?.number);
    if (seasonNumber === null || seasonNumber <= 0) continue;
    for (const episode of season.episodes || []) {
      const episodeNumber = asNumber(episode?.number ?? episode?.episode);
      if (episodeNumber === null || episodeNumber <= 0) continue;
      entries.push({
        season: seasonNumber,
        episode: episodeNumber,
        title: episode?.title || episode?.name || null,
        videoId: null,
      });
    }
  }
  entries.sort(compareEpisodeEntries);
  traktEpisodeCache.set(showLookupId, entries);
  return entries;
}

async function resolveImportedEpisodeMapping(context, params) {
  if (!context?.addons?.length) return null;
  if (!episodeMapperCanContinue(context)) return null;
  const cacheKey = [
    context.effectiveProfileId,
    params.contentType,
    params.contentId,
    params.season,
    params.episode,
    normalizeEpisodeTitle(params.episodeTitle),
  ].join("|");
  if (episodeMappingCache.has(cacheKey)) return episodeMappingCache.get(cacheKey);

  let mapped = null;
  try {
    const addonEpisodes = await getAddonEpisodes(params.contentId, params.contentType, context);
    if (!episodeMapperCanContinue(context)) return null;
    const showLookupId = resolveShowLookupId(params.show?.ids, params.contentId);
    const traktEpisodes = await getTraktEpisodes(showLookupId, context);
    if (!episodeMapperCanContinue(context)) return null;

    let triedRemap = false;
    if (addonEpisodes.length && traktEpisodes.length) {
      const addonHasEpisode = addonEpisodes.some((item) => item.season === params.season && item.episode === params.episode);
      if (!(addonHasEpisode && hasSameSeasonStructure(addonEpisodes, traktEpisodes))) {
        triedRemap = true;
        mapped = reverseRemapEpisodeByTitleOrIndex({
          requestedSeason: params.season,
          requestedEpisode: params.episode,
          requestedTitle: params.episodeTitle,
          addonEpisodes,
          traktEpisodes,
        });
      }
    }
    if (triedRemap && !mapped) {
      noteEpisodeRemapFallback(
        context,
        "unmapped",
        `no confident remap for ${params.show?.title || params.contentId} S${pad2(params.season)}E${pad2(params.episode)}; using Trakt numbering.`,
      );
    }
  } catch {
    noteEpisodeRemapFallback(
      context,
      "error",
      `unexpected remap error for ${params.show?.title || params.contentId} S${pad2(params.season)}E${pad2(params.episode)}; using Trakt numbering.`,
    );
    mapped = null;
  }

  episodeMappingCache.set(cacheKey, mapped);
  return mapped;
}

function noteEpisodeRemapFallback(context, type, message) {
  if (!context) return;
  context.fallbackStats ||= {};
  context.fallbackLogCounts ||= {};
  context.fallbackStats[type] = (context.fallbackStats[type] || 0) + 1;
  context.fallbackLogCounts[type] = (context.fallbackLogCounts[type] || 0) + 1;

  const count = context.fallbackLogCounts[type];
  if (count <= EPISODE_REMAP_FALLBACK_LOG_LIMIT) {
    logLine(`Episode remapping fallback: ${message}`);
  }
}

function logEpisodeRemapFallbackSummary(context) {
  const stats = context?.fallbackStats || {};
  const total = Object.values(stats).reduce((sum, value) => sum + Number(value || 0), 0);
  if (!total) return;
  const parts = [
    ["metadata", "addon metadata unavailable"],
    ["trakt", "Trakt episode lookup unavailable"],
    ["unmapped", "no confident remap"],
    ["error", "remap errors"],
    ["budget", "remapping time budget exceeded"],
  ]
    .filter(([key]) => stats[key])
    .map(([key, label]) => `${stats[key]} ${label}`);
  logLine(`Episode remapping fallback summary: ${parts.join(", ")}. Affected items used original Trakt numbering.`);
}

function episodeMapperCanContinue(context) {
  if (!context || context.disabled) return false;
  if (!context.startedAt) {
    context.startedAt = Date.now();
    return true;
  }
  const budgetMs = context.totalBudgetMs || EPISODE_REMAP_TOTAL_BUDGET_MS;
  if (Date.now() - context.startedAt <= budgetMs) return true;
  context.disabled = true;
  if (!context.timeoutLogged) {
    context.timeoutLogged = true;
    context.fallbackStats ||= {};
    context.fallbackStats.budget = (context.fallbackStats.budget || 0) + 1;
    logLine(`Episode remapping exceeded the ${Math.round(budgetMs / 1000)}s guard. Continuing this sync without remapping the remaining episodes.`);
  }
  return false;
}

function reverseRemapEpisodeByTitleOrIndex({
  requestedSeason,
  requestedEpisode,
  requestedTitle,
  addonEpisodes,
  traktEpisodes,
}) {
  return remapEpisodeBetweenLists({
    requestedSeason,
    requestedEpisode,
    requestedTitle,
    requestedVideoId: null,
    sourceEpisodes: traktEpisodes,
    targetEpisodes: addonEpisodes,
  });
}

function remapEpisodeBetweenLists({
  requestedSeason,
  requestedEpisode,
  requestedVideoId,
  requestedTitle,
  sourceEpisodes,
  targetEpisodes,
}) {
  if (!sourceEpisodes.length || !targetEpisodes.length) return null;

  const orderedSourceEpisodes = [...sourceEpisodes].sort(compareEpisodeEntries);
  const orderedTargetEpisodes = [...targetEpisodes].sort(compareEpisodeEntries);
  const currentSourceEpisode = requestedVideoId
    ? orderedSourceEpisodes.find((item) => item.videoId === requestedVideoId)
    : null;
  const sourceEpisode = currentSourceEpisode
    || orderedSourceEpisodes.find((item) => item.season === requestedSeason && item.episode === requestedEpisode);

  if (!sourceEpisode) return null;

  const normalizedTitle = normalizeEpisodeTitle(requestedTitle || sourceEpisode.title);
  if (isUsefulEpisodeTitle(normalizedTitle)) {
    const titleMatches = orderedTargetEpisodes.filter((item) => normalizeEpisodeTitle(item.title) === normalizedTitle);
    if (titleMatches.length === 1) {
      return titleMatches[0];
    }
  }

  const sourceIndex = orderedSourceEpisodes.indexOf(sourceEpisode);
  if (sourceIndex < 0 || sourceIndex >= orderedTargetEpisodes.length) return null;
  return orderedTargetEpisodes[sourceIndex];
}

function compareEpisodeEntries(left, right) {
  return (left.season - right.season) || (left.episode - right.episode);
}

function normalizeEpisodeTitle(title) {
  if (title === null || title === undefined) return "";
  const value = String(title);
  if (normalizedEpisodeTitleCache.has(value)) return normalizedEpisodeTitleCache.get(value);
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  normalizedEpisodeTitleCache.set(value, normalized);
  return normalized;
}

function isUsefulEpisodeTitle(title) {
  if (!title) return false;
  return !/^(episode|ep|e) \d+$/.test(title);
}

function hasSameSeasonStructure(leftEpisodes, rightEpisodes) {
  const leftCounts = seasonEpisodeCounts(leftEpisodes);
  const rightCounts = seasonEpisodeCounts(rightEpisodes);
  if (leftCounts.size !== rightCounts.size) return false;
  for (const [season, count] of leftCounts.entries()) {
    if (rightCounts.get(season) !== count) return false;
  }
  return true;
}

function seasonEpisodeCounts(episodes) {
  const counts = new Map();
  for (const episode of episodes) {
    counts.set(episode.season, (counts.get(episode.season) || 0) + 1);
  }
  return counts;
}

function resolveShowLookupId(ids, contentId) {
  const lookup = lookupFromIds(ids);
  if (lookup) return lookup;
  const parsed = parseContentId(contentId);
  return parsed.imdb || parsed.trakt || parsed.slug || "";
}

function lookupFromIds(ids) {
  if (!ids) return "";
  if (typeof ids.imdb === "string" && /^tt\d+$/i.test(ids.imdb)) return ids.imdb;
  if (ids.trakt !== undefined && ids.trakt !== null && String(ids.trakt).trim()) return String(ids.trakt);
  if (typeof ids.slug === "string" && ids.slug.trim()) return ids.slug.trim();
  return "";
}

function parseContentId(value) {
  const text = String(value || "").trim();
  if (/^tt\d+$/i.test(text)) return { imdb: text };
  const imdbMatch = text.match(/^imdb:(tt\d+)$/i);
  if (imdbMatch) return { imdb: imdbMatch[1] };
  const traktMatch = text.match(/^trakt:(?:show:|series:|tv:)?([0-9]+|[a-z0-9-]+)$/i);
  if (traktMatch) {
    return /^\d+$/.test(traktMatch[1]) ? { trakt: traktMatch[1] } : { slug: traktMatch[1] };
  }
  return {};
}

function barePrefixedId(value, prefix) {
  const text = String(value || "").trim();
  const expected = `${prefix}:`;
  return text.toLowerCase().startsWith(expected) ? text.slice(expected.length) : null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

async function pullTraktPlan(options) {
  const remaps = parseRemaps(options.idRemaps);
  const plan = {
    history: [],
    progress: [],
    library: [],
    skipped: [],
    fallbackIds: 0,
    remappedEpisodes: 0,
  };
  const episodeMapper = options.syncHistory || options.syncProgress
    ? await prepareEpisodeMapper()
    : null;

  if (options.syncHistory) {
    const [movies, shows] = await Promise.all([
      fetchAllTrakt(["/users/me/watched/movies", "/sync/watched/movies"], { extended: "full" }, "watched movies", options, { paged: false }),
      fetchAllTrakt(["/users/me/watched/shows", "/sync/watched/shows"], { extended: "full" }, "watched shows", options, { paged: false }),
    ]);
    plan.history.push(...mapWatchedMovies(movies, remaps, plan));
    plan.history.push(...(await mapWatchedShows(shows, remaps, plan, episodeMapper)));
    plan.history = dedupeBy(plan.history, watchedKey, "watched_at");
    logLine(`Mapped ${plan.history.length} watched items for Nuvio.`);
  }

  if (options.syncProgress) {
    let playbackMovies = await fetchAllTraktOptional(["/sync/playback/movies"], { extended: "full" }, "movie progress", options);
    let playbackEpisodes = await fetchAllTraktOptional(["/sync/playback/episodes"], { extended: "full" }, "episode progress", options);

    if (!playbackMovies.length || !playbackEpisodes.length) {
      const allPlayback = await fetchAllTraktOptional(["/sync/playback"], { extended: "full" }, "playback progress", options);
      if (!playbackMovies.length) playbackMovies = allPlayback.filter((item) => item.type === "movie" || item.movie);
      if (!playbackEpisodes.length) playbackEpisodes = allPlayback.filter((item) => item.type === "episode" || item.episode);
    }

    plan.progress.push(...(await mapPlayback(playbackMovies, "movie", remaps, plan, options, episodeMapper)));
    plan.progress.push(...(await mapPlayback(playbackEpisodes, "episode", remaps, plan, options, episodeMapper)));
    plan.progress = dedupeBy(plan.progress, progressKey, "last_watched");
    logLine(`Mapped ${plan.progress.length} continue-watching entries for Nuvio.`);
  }

  if (options.syncWatchlist) {
    const [movies, shows] = await Promise.all([
      fetchAllTrakt(
        ["/users/me/watchlist/movies/added", "/users/me/watchlist/movies"],
        { extended: "full" },
        "watchlist movies",
        options,
      ),
      fetchAllTrakt(
        ["/users/me/watchlist/shows/added", "/users/me/watchlist/shows"],
        { extended: "full" },
        "watchlist shows",
        options,
      ),
    ]);
    plan.library.push(...mapLibraryItems(movies, "watchlist", "movie", remaps, plan));
    plan.library.push(...mapLibraryItems(shows, "watchlist", "show", remaps, plan));
  }

  if (options.syncCollection) {
    const [movies, shows] = await Promise.all([
      fetchAllTrakt(["/sync/collection/movies"], { extended: "full" }, "collection movies", options),
      fetchAllTrakt(["/sync/collection/shows"], { extended: "full" }, "collection shows", options, { paged: false }),
    ]);
    plan.library.push(...mapLibraryItems(movies, "collection", "movie", remaps, plan));
    plan.library.push(...mapLibraryItems(shows, "collection", "show", remaps, plan));
  }

  plan.library = dedupeBy(plan.library, (item) => item.content_id, "added_at");
  if (plan.library.length) {
    logLine(`Mapped ${plan.library.length} library items. Existing Nuvio library will be merged before full replace.`);
  }
  if (plan.skipped.length) {
    logLine(`Skipped ${plan.skipped.length} items that could not be mapped safely.`);
  }
  if (plan.fallbackIds) {
    logLine(`${plan.fallbackIds} items used fallback IDs. Add remaps if Nuvio cannot resolve those titles.`);
  }
  if (plan.remappedEpisodes) {
    logLine(`Remapped ${plan.remappedEpisodes} episode entries with Nuvio addon episode order.`);
  }
  logEpisodeRemapFallbackSummary(episodeMapper);

  return plan;
}

function mapWatchedMovies(items, remaps, plan) {
  const mapped = [];
  for (const item of items) {
    const movie = item.movie || item;
    const id = resolveContentId(movie?.ids, "movie", remaps, plan);
    if (!id) {
      skip(plan, movie?.title || "movie", "missing movie ID");
      continue;
    }
    mapped.push({
      content_id: id.value,
      content_type: "movie",
      title: movie.title || "Untitled movie",
      watched_at: toEpochMs(item.last_watched_at || item.watched_at || item.last_updated_at),
    });
  }
  return mapped;
}

async function mapWatchedShows(items, remaps, plan, episodeMapper) {
  const mapped = [];
  for (const record of items) {
    const show = record.show || record;
    const id = resolveContentId(show?.ids, "show", remaps, plan);
    if (!id) {
      skip(plan, show?.title || "show", "missing show ID");
      continue;
    }

    for (const season of record.seasons || []) {
      for (const episode of season.episodes || []) {
        const seasonNumber = asNumber(season.number);
        const episodeNumber = asNumber(episode.number);
        if (seasonNumber === null || episodeNumber === null) {
          skip(plan, show?.title || id.value, "missing season or episode number");
          continue;
        }
        const episodeTitle = episode.title || episode.name || null;
        const remapped = await resolveImportedEpisodeMapping(episodeMapper, {
          contentId: id.value,
          contentType: "series",
          show,
          season: seasonNumber,
          episode: episodeNumber,
          episodeTitle,
        });
        const targetSeason = remapped?.season ?? seasonNumber;
        const targetEpisode = remapped?.episode ?? episodeNumber;
        const targetTitle = remapped?.title || episodeTitle;
        const wasRemapped = targetSeason !== seasonNumber || targetEpisode !== episodeNumber;
        if (wasRemapped) plan.remappedEpisodes += 1;
        mapped.push({
          content_id: id.value,
          content_type: "series",
          title: targetTitle
            ? `${show.title || "Series"} - ${targetTitle}`
            : `${show.title || "Series"} S${pad2(targetSeason)}E${pad2(targetEpisode)}`,
          season: targetSeason,
          episode: targetEpisode,
          watched_at: toEpochMs(episode.last_watched_at || record.last_watched_at || record.last_updated_at),
          _remapped_from: wasRemapped ? `S${pad2(seasonNumber)}E${pad2(episodeNumber)}` : null,
        });
      }
    }
  }
  return mapped;
}

async function mapPlayback(items, forcedType, remaps, plan, options, episodeMapper) {
  const mapped = [];
  for (const entry of items) {
    const type = forcedType || entry.type;
    const progress = Number(entry.progress);
    if (!Number.isFinite(progress) || progress <= 0) {
      continue;
    }
    if (!options.keepFinishedProgress && progress >= 95) {
      continue;
    }

    if (type === "movie" || entry.movie) {
      const movie = entry.movie;
      const id = resolveContentId(movie?.ids, "movie", remaps, plan);
      if (!id) {
        skip(plan, movie?.title || "movie progress", "missing movie ID");
        continue;
      }
      const duration = durationMs(movie?.runtime, options.estimateDuration ? 90 : 0);
      if (!duration) {
        skip(plan, movie?.title || id.value, "missing movie runtime");
        continue;
      }
      mapped.push({
        content_id: id.value,
        content_type: "movie",
        video_id: id.value,
        position: clamp(Math.round(duration * (progress / 100)), 1, Math.max(1, duration - 1000)),
        duration,
        last_watched: toEpochMs(entry.paused_at || entry.watched_at || entry.updated_at),
        _title: movie?.title || id.value,
      });
      continue;
    }

    const episode = entry.episode;
    const show = entry.show;
    const id = resolveContentId(show?.ids, "show", remaps, plan);
    const seasonNumber = asNumber(episode?.season);
    const episodeNumber = asNumber(episode?.number);
    if (!id || seasonNumber === null || episodeNumber === null) {
      skip(plan, show?.title || episode?.title || "episode progress", "missing show ID or episode number");
      continue;
    }
    const duration = durationMs(episode?.runtime || show?.runtime, options.estimateDuration ? 45 : 0);
    if (!duration) {
      skip(plan, episode?.title || id.value, "missing episode runtime");
      continue;
    }
    const episodeTitle = episode?.title || episode?.name || null;
    const remapped = await resolveImportedEpisodeMapping(episodeMapper, {
      contentId: id.value,
      contentType: "series",
      show,
      season: seasonNumber,
      episode: episodeNumber,
      episodeTitle,
    });
    const targetSeason = remapped?.season ?? seasonNumber;
    const targetEpisode = remapped?.episode ?? episodeNumber;
    const targetTitle = remapped?.title || episodeTitle;
    const wasRemapped = targetSeason !== seasonNumber || targetEpisode !== episodeNumber;
    if (wasRemapped) plan.remappedEpisodes += 1;
    mapped.push({
      content_id: id.value,
      content_type: "series",
      video_id: remapped?.videoId || `${id.value}:${targetSeason}:${targetEpisode}`,
      season: targetSeason,
      episode: targetEpisode,
      position: clamp(Math.round(duration * (progress / 100)), 1, Math.max(1, duration - 1000)),
      duration,
      last_watched: toEpochMs(entry.paused_at || entry.watched_at || entry.updated_at),
      _title: targetTitle
        ? `${show?.title || "Series"} - ${targetTitle}`
        : `${show?.title || "Series"} S${pad2(targetSeason)}E${pad2(targetEpisode)}`,
      _remapped_from: wasRemapped ? `S${pad2(seasonNumber)}E${pad2(episodeNumber)}` : null,
    });
  }
  return mapped;
}

function mapLibraryItems(items, source, contentKind, remaps, plan) {
  const mapped = [];
  for (const item of items) {
    const media = contentKind === "movie" ? item.movie || item : item.show || item;
    const id = resolveContentId(media?.ids, contentKind, remaps, plan);
    if (!id) {
      skip(plan, media?.title || source, `missing ${contentKind} ID`);
      continue;
    }
    mapped.push({
      content_id: id.value,
      content_type: contentKind === "movie" ? "movie" : "series",
      name: media.title || "Untitled",
      poster: null,
      poster_shape: "POSTER",
      background: null,
      description: media.overview || null,
      release_info: media.year ? String(media.year) : null,
      imdb_rating: typeof media.rating === "number" ? media.rating : null,
      genres: Array.isArray(media.genres) ? media.genres : [],
      addon_base_url: "https://trakt.tv",
      added_at: toEpochMs(item.listed_at || item.collected_at || item.updated_at),
      _source: source,
    });
  }
  return mapped;
}

function resolveContentId(ids, kind, remaps, plan) {
  const candidates = idCandidates(ids, kind);
  for (const candidate of candidates) {
    for (const key of [candidate.value, ...(candidate.remapKeys || [])]) {
      if (remaps[key]) {
        return { value: remaps[key], fallback: false, remapped: true };
      }
    }
  }
  const selected = candidates.find((candidate) => candidate.usable !== false);
  if (!selected) return null;
  if (selected.fallback) plan.fallbackIds += 1;
  return selected;
}

function idCandidates(ids = {}, kind) {
  const list = [];
  // Match Nuvio's own Trakt import order: IMDb, then TMDB, then numeric Trakt.
  const imdb = String(ids.imdb || "").trim();
  if (/^tt\d+$/i.test(imdb)) {
    list.push({
      value: imdb,
      fallback: false,
      remapKeys: [`imdb:${imdb}`],
    });
  }
  if (ids.tmdb) {
    list.push({ value: `tmdb:${ids.tmdb}`, fallback: false });
  }
  if (ids.trakt) {
    list.push({
      value: `trakt:${ids.trakt}`,
      fallback: true,
      remapKeys: [`trakt:${kind}:${ids.trakt}`],
    });
  }
  if (ids.tvdb) {
    list.push({ value: `tvdb:${ids.tvdb}`, fallback: true, usable: false });
  }
  if (ids.slug) {
    list.push({ value: `trakt:${kind}:${ids.slug}`, fallback: true, usable: false });
  }
  return list;
}

async function pushPlanToNuvio(plan) {
  const profileId = Number(dom.profileSelect.value || state.nuvio.profileId || 1);
  state.nuvio.profileId = profileId;
  saveState();

  if (plan.history.length) {
    logLine(`Pushing ${plan.history.length} watched items to Nuvio profile ${profileId}.`);
    for (const chunk of chunks(plan.history.map(stripPrivateFields), 500)) {
      await nuvioRpc("sync_push_watched_items", {
        p_profile_id: profileId,
        p_items: chunk,
      });
      logLine(`Pushed watched batch of ${chunk.length}.`);
    }
  }

  if (plan.progress.length) {
    logLine(`Pushing ${plan.progress.length} progress entries to Nuvio profile ${profileId}.`);
    for (const chunk of chunks(plan.progress.map(stripPrivateFields), 300)) {
      await nuvioRpc("sync_push_watch_progress", {
        p_profile_id: profileId,
        p_entries: chunk,
      });
      logLine(`Pushed progress batch of ${chunk.length}.`);
    }
  }

  if (plan.library.length) {
    logLine("Pulling current Nuvio library before merge because Nuvio library push is full replace.");
    const existing = await pullNuvioLibrary(profileId);
    const merged = dedupeBy([...existing.map(cleanNuvioLibraryItem), ...plan.library.map(stripPrivateFields)], (item) => item.content_id, "added_at");
    await nuvioRpc("sync_push_library", {
      p_profile_id: profileId,
      p_items: merged,
    });
    logLine(`Merged ${plan.library.length} imported library items with ${existing.length} existing Nuvio items, then pushed ${merged.length} total.`);
  }

  await verifyNuvioPush(profileId, plan);
}

async function pullNuvioLibrary(profileId) {
  const limit = 500;
  const all = [];
  for (let offset = 0; offset < 100000; offset += limit) {
    const batch = await nuvioRpc("sync_pull_library", {
      p_profile_id: profileId,
      p_limit: limit,
      p_offset: offset,
    });
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < limit) break;
  }
  return all;
}

async function pullNuvioWatchedItems(profileId) {
  const pageSize = 1000;
  const all = [];
  for (let page = 1; page <= 1000; page += 1) {
    const batch = await nuvioRpc("sync_pull_watched_items", {
      p_profile_id: profileId,
      p_page: page,
      p_page_size: pageSize,
    });
    const rows = Array.isArray(batch) ? batch : [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function pullNuvioWatchProgress(profileId) {
  const rows = await nuvioRpc("sync_pull_watch_progress", {
    p_profile_id: profileId,
  });
  return Array.isArray(rows) ? rows : [];
}

async function verifyNuvioPush(profileId, plan) {
  if (plan.history.length) {
    const expected = new Set(plan.history.map(watchedKey));
    const watched = await pullNuvioWatchedItems(profileId);
    const actual = new Set(watched.map(watchedKey));
    const matched = [...expected].filter((key) => actual.has(key)).length;
    logLine(`Verified ${matched}/${expected.size} watched keys in Nuvio Sync profile ${profileId}.`);
  }

  if (plan.progress.length) {
    const expected = new Set(plan.progress.map(progressKey));
    const progress = await pullNuvioWatchProgress(profileId);
    const actual = new Set(progress.map(progressKey));
    const matched = [...expected].filter((key) => actual.has(key)).length;
    logLine(`Verified ${matched}/${expected.size} progress keys in Nuvio Sync profile ${profileId}.`);
  }
}

function cleanNuvioLibraryItem(item) {
  return {
    content_id: item.content_id,
    content_type: item.content_type,
    name: item.name,
    poster: item.poster,
    poster_shape: item.poster_shape || "POSTER",
    background: item.background,
    description: item.description,
    release_info: item.release_info,
    imdb_rating: item.imdb_rating,
    genres: Array.isArray(item.genres) ? item.genres : [],
    addon_base_url: item.addon_base_url,
    added_at: Number(item.added_at || Date.now()),
  };
}

function stripPrivateFields(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith("_")));
}

async function previewSync() {
  clearLog();
  const options = readOptions();
  validateSyncInputs(options, false);
  logLine("Preview pull started.");
  lastPlan = await pullTraktPlan(options);
  updateStats(lastPlan);
  renderPreview(lastPlan, 1);
  logLine("Preview complete. Nothing was pushed.");
  toast("Preview complete.");
}

async function runSync() {
  clearLog();
  const options = readOptions();
  validateSyncInputs(options, true);
  logLine("Sync started.");
  lastPlan = await pullTraktPlan(options);
  updateStats(lastPlan);
  renderPreview(lastPlan, 1);
  await pushPlanToNuvio(lastPlan);
  logLine("Sync complete.");
  toast("Sync complete.");
}

function validateSyncInputs(options, requireNuvio) {
  if (!state.trakt.token?.access_token) {
    throw new Error("Connect Trakt before pulling data.");
  }
  if (requireNuvio && !state.nuvio.session?.access_token) {
    throw new Error("Connect Nuvio before syncing.");
  }
  if (!options.syncHistory && !options.syncProgress && !options.syncWatchlist && !options.syncCollection) {
    throw new Error("Choose at least one sync scope.");
  }
  parseRemaps(options.idRemaps);
}

function parseRemaps(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("ID remaps must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ID remap JSON: ${error.message}`);
  }
}

function skip(plan, label, reason) {
  plan.skipped.push({ label, reason });
}

function dedupeBy(items, keyFn, timeField) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || Number(item[timeField] || 0) >= Number(existing[timeField] || 0)) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) => Number(b[timeField] || 0) - Number(a[timeField] || 0));
}

function watchedKey(item) {
  return [item.content_id, item.season ?? "", item.episode ?? ""].join("|");
}

function progressKey(item) {
  return [item.content_id, item.season ?? "", item.episode ?? ""].join("|");
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function toEpochMs(value) {
  if (!value) return Date.now();
  if (typeof value === "number") return value > 100000000000 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function durationMs(runtimeMinutes, fallbackMinutes) {
  const runtime = Number(runtimeMinutes);
  if (Number.isFinite(runtime) && runtime > 0) return Math.round(runtime * 60000);
  const fallback = Number(fallbackMinutes);
  return fallback > 0 ? Math.round(fallback * 60000) : 0;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatMsDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function cryptoRandomString() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeTraktClientId(value) {
  const clientId = String(value || "").trim();
  return /^[a-f0-9]{64}$/i.test(clientId) ? clientId : "";
}

function extractTraktClientIdFromUrl(value) {
  try {
    return normalizeTraktClientId(new URL(value).searchParams.get("client_id"));
  } catch {
    return "";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function disconnectTrakt() {
  state.trakt.token = null;
  state.trakt.clientId = "";
  pendingTraktState = null;
  pendingTraktClientId = "";
  saveState();
  updateAuthStatus();
  logLine("Trakt disconnected locally.");
}

async function disconnectNuvio() {
  if (state.nuvio.session?.access_token) {
    try {
      await requestJson(`${NUVIO_BASE}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: NUVIO_KEY,
          Authorization: `Bearer ${state.nuvio.session.access_token}`,
        },
      });
    } catch (error) {
      logLine(`Nuvio logout warning: ${error.message}`);
    }
  }
  state.nuvio.session = null;
  state.nuvio.profiles = [];
  clearEpisodeMappingCaches();
  saveState();
  renderProfiles();
  updateAuthStatus();
  logLine("Nuvio disconnected locally.");
}

function bind(action, handler, busyLabel = "", successLabel = "") {
  if (!action) return;
  rememberButtonLabel(action);
  action.addEventListener("click", async () => {
    let succeeded = false;
    try {
      setButtonLabel(action, busyLabel);
      setBusy(true);
      await handler();
      succeeded = true;
    } catch (error) {
      logLine(`Error: ${error.message}`);
      toast(error.message);
    } finally {
      if (!(action === dom.startTraktLogin && traktPending)) {
        restoreButtonLabel(action);
      }
      setBusy(false);
      if (succeeded && successLabel) {
        flashButtonLabel(action, successLabel);
      }
      updateAuthStatus();
    }
  });
}

bind(dom.startTraktLogin, toggleTraktConnection);
bind(dom.loginNuvio, toggleNuvioConnection);
bind(dom.previewSync, previewSync, "Loading preview...", "Preview ready");
bind(dom.runSync, runSync, "Syncing...", "Synced");
bind(dom.logoutTrakt, disconnectTrakt);
bind(dom.logoutNuvio, disconnectNuvio);

dom.copyLog.addEventListener("click", async () => {
  await navigator.clipboard.writeText(dom.log.textContent);
  toast("Log copied.");
});

[
  dom.syncHistory,
  dom.syncProgress,
  dom.syncWatchlist,
  dom.syncCollection,
  dom.profileSelect,
].filter(Boolean).forEach((field) => {
  field.addEventListener("change", readOptions);
  field.addEventListener("input", readOptions);
});

if (dom.previewPrev) {
  dom.previewPrev.addEventListener("click", () => renderPreviewPage(previewPage - 1));
}
if (dom.previewNext) {
  dom.previewNext.addEventListener("click", () => renderPreviewPage(previewPage + 1));
}

window.addEventListener("online", () => toast("Network is back."));
window.addEventListener("offline", () => toast("You appear to be offline."));
window.addEventListener("message", (event) => {
  handleTraktOauthPayload(event.data, event.origin || "");
});
if ("BroadcastChannel" in window) {
  traktBroadcastChannel = new BroadcastChannel("nuvio-trakt-bridge.trakt-oauth");
  traktBroadcastChannel.addEventListener("message", (event) => {
    handleTraktOauthPayload(event.data, "");
  });
}
window.addEventListener("beforeunload", () => {
  if (traktBroadcastChannel) {
    traktBroadcastChannel.close();
  }
});

hydrateForm();
