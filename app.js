"use strict";

const SIMKL_API = "https://api.simkl.com";
const NUVIO_BASE = "https://api.nuvio.tv";
const NUVIO_KEY = "sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN";
const APP_CONFIG = globalThis.NUVIO_SIMKL_BRIDGE_CONFIG || {};
const PREFS_KEY = "nuvio-simkl-bridge:prefs:v1";
const SESSION_KEY = "nuvio-simkl-bridge:session:v1";
const LEGACY_STORAGE_KEY = "nuvio-simkl-bridge:v1";

const $ = (selector) => document.querySelector(selector);
const dom = {
  simklStatus: $("#simkl-status"),
  nuvioStatus: $("#nuvio-status"),
  startSimklLogin: $("#start-simkl-login"),
  logoutSimkl: $("#logout-simkl"),
  nuvioEmail: $("#nuvio-email"),
  nuvioPassword: $("#nuvio-password"),
  loginNuvio: $("#login-nuvio"),
  logoutNuvio: $("#logout-nuvio"),
  profileSelect: $("#profile-select"),
  metadataAddonField: $("#metadata-addon-field"),
  metadataAddonSelect: $("#metadata-addon-select"),
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
let simklPending = false;
let pendingSimklState = null;
let pendingSimklClientId = "";
let simklBroadcastChannel = null;
const PREVIEW_PAGE_SIZE = 50;
const EPISODE_REMAP_META_TIMEOUT_MS = 15000;
const EPISODE_REMAP_SIMKL_TIMEOUT_MS = 15000;
const EPISODE_REMAP_TOTAL_BUDGET_MS = 30 * 60 * 1000;
const LIBRARY_META_ENRICH_CONCURRENCY = 5;
let episodeMappingContextPromise = null;
let episodeMappingContextKey = "";
const addonManifestCache = new Map();
const addonMetaCache = new Map();
const addonEpisodeCache = new Map();
const simklEpisodeCache = new Map();
const episodeMappingCache = new Map();
const normalizedEpisodeTitleCache = new Map();

function defaultState() {
  return {
    simkl: {
      token: null,
      clientId: "",
    },
    nuvio: {
      session: null,
      profiles: [],
      profileId: 1,
      metadataAddons: [],
      metadataAddonUrl: "",
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
  renderMetadataAddons();
  updateAuthStatus();
  clearLog();
  logLine("Ready. Connect Simkl and Nuvio, then preview before syncing.");
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
  state.nuvio.metadataAddonUrl = canonicalizeAddonUrl(
    dom.metadataAddonSelect?.value || state.nuvio.metadataAddonUrl || "",
  );
  saveState();
  return state.options;
}

function updateAuthStatus() {
  const simklConnected = Boolean(state.simkl.token?.access_token);
  const nuvioConnected = Boolean(state.nuvio.session?.access_token);

  dom.simklStatus.textContent = simklConnected ? "Simkl connected" : "Simkl disconnected";
  dom.simklStatus.classList.toggle("is-connected", simklConnected);
  dom.nuvioStatus.textContent = nuvioConnected ? "Nuvio connected" : "Nuvio disconnected";
  dom.nuvioStatus.classList.toggle("is-connected", nuvioConnected);
  updateAuthButtons(simklConnected, nuvioConnected);
  updateSyncActionButtons(simklConnected, nuvioConnected);
}

function updateAuthButtons(simklConnected, nuvioConnected) {
  updateConnectedButton(dom.startSimklLogin, simklConnected, "Disconnect Simkl");
  updateConnectedButton(dom.loginNuvio, nuvioConnected, "Disconnect");
}

function updateSyncActionButtons(simklConnected, nuvioConnected) {
  const ready = simklConnected && nuvioConnected;
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
  if (!(button === dom.startSimklLogin && simklPending)) {
    restoreButtonLabel(button);
  }
}

function simklLoginUrlEndpoint() {
  return String(APP_CONFIG.simklLoginUrlEndpoint || "/api/simkl/login-url").trim();
}

function simklRefreshEndpoint() {
  return String(APP_CONFIG.simklRefreshEndpoint || "/api/simkl/refresh").trim();
}

function simklCallbackOrigin() {
  return String(APP_CONFIG.simklCallbackOrigin || location.origin || "").trim();
}

function allowedSimklOrigins() {
  return [...new Set([location.origin, simklCallbackOrigin()].filter(Boolean))];
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

function getEffectiveNuvioProfileId(profileId = Number(state.nuvio.profileId || 1)) {
  const profile = state.nuvio.profiles.find((item) => Number(item.profile_index || item.id || 1) === profileId);
  return profileId !== 1 && profile?.uses_primary_addons ? 1 : profileId;
}

function getSelectedMetadataAddonUrl() {
  const fromDom = canonicalizeAddonUrl(dom.metadataAddonSelect?.value || "");
  if (fromDom) return fromDom;
  return canonicalizeAddonUrl(state.nuvio.metadataAddonUrl || "");
}

function getSelectedMetadataAddonName() {
  const selectedUrl = getSelectedMetadataAddonUrl();
  const match = (state.nuvio.metadataAddons || []).find((addon) => addon.baseUrl === selectedUrl);
  return match?.name || selectedUrl || "metadata addon";
}

function renderMetadataAddons() {
  if (!dom.metadataAddonSelect) return;

  const connected = Boolean(state.nuvio.session?.access_token);
  const addons = state.nuvio.metadataAddons || [];

  if (!connected) {
    dom.metadataAddonSelect.innerHTML = '<option value="">Sign in to load addons</option>';
    dom.metadataAddonSelect.disabled = true;
    return;
  }

  if (!addons.length) {
    dom.metadataAddonSelect.innerHTML = '<option value="">No metadata addons on this profile</option>';
    dom.metadataAddonSelect.disabled = true;
    return;
  }

  const selectedUrl = getSelectedMetadataAddonUrl() || addons[0].baseUrl;
  dom.metadataAddonSelect.innerHTML = addons
    .map((addon) => {
      const selected = addon.baseUrl === selectedUrl ? "selected" : "";
      return `<option value="${escapeHtml(addon.baseUrl)}" ${selected}>${escapeHtml(addon.name)}</option>`;
    })
    .join("");

  state.nuvio.metadataAddonUrl = selectedUrl;
  dom.metadataAddonSelect.disabled = addons.length <= 1;
}

function filterMetadataAddonsBySelection(addons) {
  const selectedUrl = getSelectedMetadataAddonUrl();
  if (!selectedUrl) return addons;
  const filtered = addons.filter((addon) => addon.baseUrl === selectedUrl);
  return filtered.length ? filtered : addons;
}

function setBusy(isBusy) {
  const simklConnected = Boolean(state.simkl.token?.access_token);
  const nuvioConnected = Boolean(state.nuvio.session?.access_token);
  const syncReady = simklConnected && nuvioConnected;
  [
    dom.startSimklLogin,
    dom.loginNuvio,
    dom.previewSync,
    dom.runSync,
  ].forEach((button) => {
    if (!button) return;
    button.disabled = isBusy
      || (button === dom.startSimklLogin && simklPending)
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

async function startSimklPopupLogin() {
  readOptions();
  if (simklPending) {
    return;
  }

  simklPending = true;
  dom.startSimklLogin.disabled = true;
  setButtonLabel(dom.startSimklLogin, "Opening Simkl...");
  logLine("Opening Simkl sign in.");
  try {
    const { data } = await requestJson(simklLoginUrlEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ return_origin: location.origin }),
    });
    if (!data?.url) {
      throw new Error(resolveRemoteError(data) || "The Simkl login endpoint did not return a URL.");
    }
    pendingSimklState = data.state || null;
    pendingSimklClientId = normalizeSimklClientId(data.client_id || data.clientId)
      || extractSimklClientIdFromUrl(data.url);
    if (!pendingSimklClientId) {
      throw new Error("The Simkl login endpoint did not return a valid app client id.");
    }
    const popup = window.open(data.url, "simkl-sign-in", "width=600,height=780");
    if (!popup) {
      throw new Error("Allow pop-ups for this site, then click Connect Simkl again.");
    }
    popup.focus();
    setButtonLabel(dom.startSimklLogin, "Waiting for Simkl...");
    const popupWatcher = window.setInterval(() => {
      if (!simklPending) {
        window.clearInterval(popupWatcher);
        return;
      }
      if (popup.closed) {
        window.clearInterval(popupWatcher);
        simklPending = false;
        pendingSimklState = null;
        pendingSimklClientId = "";
        restoreButtonLabel(dom.startSimklLogin);
        setBusy(false);
        logLine("Simkl sign in window closed before finishing.");
      }
    }, 700);
    logLine("Approve access in the Simkl popup. This page will update automatically.");
  } catch (error) {
    simklPending = false;
    dom.startSimklLogin.disabled = false;
    restoreButtonLabel(dom.startSimklLogin);
    throw new Error(loginEndpointError(error));
  }
}

function normalizeSimklToken(token) {
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    token_type: token.token_type || "bearer",
    expires_in: token.expires_in || 7776000,
    scope: token.scope || "",
    created_at: token.created_at || Math.floor(Date.now() / 1000),
  };
}

function normalizeSimklOauthPayload(rawPayload) {
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
  if (data.source === "simkl-oauth") {
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
  if (type === "SIMKL_AUTH_SUCCESS") {
    return {
      source: "simkl-oauth",
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
  if (type === "SIMKL_AUTH_ERROR") {
    return {
      source: "simkl-oauth",
      status: "error",
      client_id: data.client_id || data.clientId || "",
      error: data.error || data.message || "simkl_error",
      error_description: data.error_description || data.description || "",
    };
  }
  return null;
}

function handleSimklOauthPayload(rawPayload, origin = "") {
  const payload = normalizeSimklOauthPayload(rawPayload);
  if (!payload || payload.source !== "simkl-oauth") return;
  if (origin && !allowedSimklOrigins().includes(origin)) return;

  simklPending = false;
  restoreButtonLabel(dom.startSimklLogin);
  dom.startSimklLogin.disabled = false;
  if (pendingSimklState && payload.state !== pendingSimklState) {
    pendingSimklState = null;
    pendingSimklClientId = "";
    logLine("Simkl sign in failed: authorization state did not match.");
    toast("Simkl sign in failed. Try connecting again.");
    return;
  }
  if (payload.status === "success" && payload.tokens?.access_token) {
    const clientId = normalizeSimklClientId(payload.client_id || payload.clientId)
      || pendingSimklClientId
      || normalizeSimklClientId(state.simkl.clientId);
    if (!clientId) {
      logLine("Simkl sign in failed: missing app client id from the login endpoint.");
      toast("Simkl sign in failed. The login endpoint is missing its app client id.");
      return;
    }
    state.simkl.token = normalizeSimklToken(payload.tokens);
    state.simkl.clientId = clientId;
    pendingSimklState = null;
    pendingSimklClientId = "";
    saveState();
    updateAuthStatus();
    logLine("Simkl connected.");
    toast("Simkl connected.");
    return;
  }
  const message = payload.error_description || payload.error || "Simkl rejected the sign in request.";
  pendingSimklState = null;
  pendingSimklClientId = "";
  logLine(`Simkl sign in failed: ${message}`);
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
    return "The Simkl login endpoint is missing. Deploy /api/simkl/login-url like the reference site, then try again.";
  }
  const remote = resolveRemoteError(error?.body);
  if (remote) {
    return remote;
  }
  return error?.message || "Unable to start Simkl sign in.";
}

async function ensureSimklAccessToken() {
  if (!state.simkl.token?.access_token) {
    throw new Error("Connect Simkl first.");
  }

  const createdAt = Number(state.simkl.token.created_at || 0);
  const expiresIn = Number(state.simkl.token.expires_in || 0);
  const expiresAt = createdAt + expiresIn;
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt && now < expiresAt - 90) {
    return state.simkl.token.access_token;
  }

  if (!state.simkl.token.refresh_token) {
    throw new Error("Simkl token expired and no refresh token was saved. Reconnect Simkl.");
  }
  logLine("Refreshing Simkl token.");
  const data = await refreshSimklToken(state.simkl.token.refresh_token);

  const clientId = state.simkl.clientId || "";
  state.simkl.token = normalizeSimklToken(data);
  state.simkl.clientId = clientId || normalizeSimklClientId(data.client_id || data.clientId);
  saveState();
  return state.simkl.token.access_token;
}

async function refreshSimklToken(refreshToken) {
  const { data } = await requestJson(simklRefreshEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  return data;
}

async function simklRequest(path, params = {}, fetchOptions = {}) {
  const accessToken = await ensureSimklAccessToken();
  const clientId = normalizeSimklClientId(state.simkl.clientId);
  if (!clientId) {
    throw new Error("Reconnect Simkl. This authorization session is missing the app client id Simkl requires for API requests.");
  }
  const url = new URL(`${SIMKL_API}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return requestJson(url.toString(), {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "simkl-api-key": clientId,
      ...(fetchOptions.headers || {}),
    },
  });
}

async function simklRequestWithTimeout(path, params = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await simklRequest(path, params, { signal: controller.signal });
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

async function toggleSimklConnection() {
  if (state.simkl.token?.access_token) {
    setButtonLabel(dom.startSimklLogin, "Disconnecting...");
    disconnectSimkl();
    return;
  }
  await startSimklPopupLogin();
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
  await loadNuvioMetadataAddons();
}

async function loadNuvioMetadataAddons() {
  if (!state.nuvio.session?.access_token) {
    state.nuvio.metadataAddons = [];
    state.nuvio.metadataAddonUrl = "";
    renderMetadataAddons();
    return;
  }

  clearEpisodeMappingCaches();
  const effectiveProfileId = getEffectiveNuvioProfileId();
  const addons = await pullNuvioMetadataAddons(effectiveProfileId);
  state.nuvio.metadataAddons = addons.map((addon) => ({
    baseUrl: addon.baseUrl,
    name: addon.name,
  }));

  const selectedUrl = getSelectedMetadataAddonUrl();
  const stillValid = state.nuvio.metadataAddons.some((addon) => addon.baseUrl === selectedUrl);
  if (!stillValid) {
    state.nuvio.metadataAddonUrl = state.nuvio.metadataAddons[0]?.baseUrl || "";
  }

  saveState();
  renderMetadataAddons();

  if (state.nuvio.metadataAddons.length > 1) {
    logLine(`Loaded ${state.nuvio.metadataAddons.length} metadata addons. Choose one for library enrichment and episode remapping.`);
  } else if (state.nuvio.metadataAddons.length === 1) {
    logLine(`Using metadata addon "${state.nuvio.metadataAddons[0].name}" for enrichment.`);
  } else {
    logLine("No compatible metadata addons were found on this Nuvio profile.");
  }
}

async function fetchAllSimkl(paths, params, label, options, fetchOptions = {}) {
  const errors = [];
  for (const path of paths) {
    try {
      return await fetchAllSimklPath(path, params, label, options, fetchOptions);
    } catch (error) {
      errors.push(error);
      if (![400, 404, 405].includes(error.status)) {
        throw error;
      }
      logLine(`Simkl endpoint ${path} did not fit (${error.message}); trying fallback if available.`);
    }
  }
  throw errors[errors.length - 1] || new Error(`Unable to fetch ${label}.`);
}

async function fetchAllSimklOptional(paths, params, label, options) {
  try {
    return await fetchAllSimkl(paths, params, label, options);
  } catch (error) {
    logLine(`Skipping ${label}: ${error.message}`);
    return [];
  }
}

const SIMKL_NON_PAGINATED_PREFIXES = [
  "/sync/all-items",
  "/sync/playback",
  "/sync/progress",
];

const SIMKL_WATCHED_STATUSES = {
  movie: new Set(["completed"]),
  show: new Set(["watching", "completed"]),
  anime: new Set(["watching", "completed"]),
};

const SIMKL_LIBRARY_STATUSES = {
  movie: new Set(["plantowatch", "completed"]),
  show: new Set(["watching", "plantowatch", "completed", "hold"]),
  anime: new Set(["watching", "plantowatch", "completed", "hold"]),
};

const SIMKL_SHOW_HISTORY_PARAMS = {
  extended: "full",
  episode_watched_at: "yes",
  include_all_episodes: "original",
};

const SIMKL_ANIME_HISTORY_PARAMS = {
  extended: "full_anime_seasons",
  episode_watched_at: "yes",
  include_all_episodes: "original",
};

const SIMKL_LIBRARY_MOVIE_PARAMS = {
  extended: "full",
};

const SIMKL_LIBRARY_SHOW_PARAMS = {
  extended: "full",
};

const SIMKL_LIBRARY_ANIME_PARAMS = {
  extended: "full_anime_seasons",
};

function formatRemapTimeout(ms) {
  if (ms >= 60000) return `${Math.round(ms / 60000)} min`;
  return `${Math.round(ms / 1000)}s`;
}

function simklEndpointUsesPagination(path) {
  return !SIMKL_NON_PAGINATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function filterSimklByStatus(items, statuses) {
  return items.filter((item) => statuses.has(item.status));
}

async function fetchAllSimklPath(path, params, label, options, fetchOptions = {}) {
  if (fetchOptions.paged === false || !simklEndpointUsesPagination(path)) {
    const { data } = await simklRequest(path, params);
    const batch = unwrapSimklResponse(data);
    logLine(`Pulled ${batch.length} ${label} from ${path}.`);
    return batch;
  }

  const limit = 1000;
  const configuredMaxPages = Number(options.maxPages);
  const simklPageCap = 20;
  const maxPages = Number.isFinite(configuredMaxPages) && configuredMaxPages > 0
    ? Math.min(configuredMaxPages, simklPageCap)
    : simklPageCap;
  const all = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, headers } = await simklRequest(path, {
      ...params,
      page,
      limit,
    });
    const batch = unwrapSimklResponse(data);
    all.push(...batch);

    const pageCount = Number(headers.get("x-pagination-page-count") || 0);
    logLine(`Pulled ${batch.length} ${label} from ${path}, page ${page}${pageCount ? `/${pageCount}` : ""}.`);

    if (pageCount && page >= pageCount) break;
    if (batch.length < limit) break;
    if (!pageCount) {
      logLine(`Simkl did not return pagination headers for ${path}; stopping after page ${page}.`);
      break;
    }
  }

  return all;
}

function unwrapSimklResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    // Simkl wraps responses in properties like "anime", "movies", "shows"
    for (const key of ["anime", "movies", "shows", "items", "data"]) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return data ? [data] : [];
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
      logLine("No compatible Nuvio metadata addon was found (streaming addons are ignored), so episode remapping is skipped.");
      return null;
    }
    context.disabled = false;
    context.startedAt = 0;
    context.timeoutLogged = false;
    context.metaTimeoutMs = EPISODE_REMAP_META_TIMEOUT_MS;
    context.simklTimeoutMs = EPISODE_REMAP_SIMKL_TIMEOUT_MS;
    context.totalBudgetMs = EPISODE_REMAP_TOTAL_BUDGET_MS;
    context.fallbackStats = {};
    context.fallbackShows = {};
    const addonName = getSelectedMetadataAddonName();
    logLine(`Using Nuvio metadata addon "${addonName}" for episode remapping.`);
    logLine(`Episode remapping fallback guard: addon ${formatRemapTimeout(context.metaTimeoutMs)}, Simkl ${formatRemapTimeout(context.simklTimeoutMs)}, total ${formatRemapTimeout(context.totalBudgetMs)}.`);
    return context;
  } catch (error) {
    logLine(`Episode remapping unavailable: ${error.message}`);
    return null;
  }
}

async function loadEpisodeMappingContext() {
  const selectedProfileId = Number(state.nuvio.profileId || 1);
  const effectiveProfileId = getEffectiveNuvioProfileId(selectedProfileId);
  const selectedAddonUrl = getSelectedMetadataAddonUrl();
  const key = `${effectiveProfileId}:${selectedAddonUrl}:${state.nuvio.session?.access_token || ""}`;

  if (episodeMappingContextPromise && episodeMappingContextKey === key) {
    return episodeMappingContextPromise;
  }

  episodeMappingContextKey = key;
  episodeMappingContextPromise = pullNuvioMetadataAddons(effectiveProfileId)
    .then((addons) => ({
      addons: filterMetadataAddonsBySelection(addons),
      effectiveProfileId,
    }))
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

  const addons = [];
  for (const row of sortedRows) {
    const addon = await fetchAddonManifest(row.url, row.name).catch(() => null);
    if (addon && addonIsEligibleForEpisodeRemapping(addon)) {
      addons.push(addon);
    }
  }
  return addons;
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

function addonHasStreamResource(addon) {
  return addon.resources.some((resource) => resource.name.toLowerCase() === "stream");
}

function addonIsEligibleForEpisodeRemapping(addon) {
  return addonHasMetaResource(addon) && !addonHasStreamResource(addon);
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

async function fetchMetaWithAddonFromAddons(context, type, id) {
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
    if (response?.meta) return { meta: response.meta, addon };
  }
  return null;
}

async function fetchMetaFromAddons(context, type, id) {
  const result = await fetchMetaWithAddonFromAddons(context, type, id);
  return result?.meta || null;
}

function isUsableLibraryMeta(meta) {
  return Boolean(meta && (meta.name || meta.poster || meta.description || meta.releaseInfo || meta.background));
}

function expandMetaIdCandidates(contentId, extraIds = []) {
  const expanded = [];
  for (const id of unique([contentId, ...extraIds])) {
    expanded.push(id);
    for (const prefix of ["mal", "tvdb", "tmdb", "simkl"]) {
      const bare = barePrefixedId(id, prefix);
      if (bare) {
        expanded.push(`${prefix}:${bare}`);
        expanded.push(bare);
      }
    }
  }
  return unique(expanded);
}

async function fetchLibraryMeta(contentId, contentType, context, extraIds = []) {
  const typeCandidates = unique([
    contentType,
    inferCanonicalMetaType(contentType),
    contentType === "anime" ? "anime" : null,
    contentType === "movie" ? "movie" : null,
    "series",
    "movie",
  ].filter(Boolean));
  const metaIdCandidates = expandMetaIdCandidates(contentId, extraIds);

  for (const type of typeCandidates) {
    for (const id of metaIdCandidates) {
      const result = await fetchMetaWithAddonFromAddons(context, type, id);
      if (isUsableLibraryMeta(result?.meta)) {
        return result;
      }
    }
  }
  return null;
}

function normalizeImageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://simkl.in${url}`;
  return url;
}

function pickSimklImageUrl(media, keys) {
  for (const key of keys) {
    const value = media?.[key];
    if (typeof value === "string") {
      const normalized = normalizeImageUrl(value);
      if (normalized) return normalized;
    }
    if (value && typeof value === "object") {
      const normalized = normalizeImageUrl(value.url || value.full || value.medium || value.large);
      if (normalized) return normalized;
    }
  }
  return null;
}

function normalizeSimklGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return genres
    .map((genre) => {
      if (typeof genre === "string") return genre.trim();
      if (genre && typeof genre === "object") return String(genre.name || genre.title || "").trim();
      return "";
    })
    .filter(Boolean);
}

function asRating(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPlaceholderAddonUrl(value) {
  const url = String(value || "").trim().toLowerCase();
  return !url || url === "https://simkl.com";
}

function applyAddonMetaToLibraryItem(item, result) {
  if (!result?.meta) return item;
  const meta = result.meta;
  const addonBaseUrl = result.addon?.baseUrl;
  const genres = Array.isArray(meta.genres) ? meta.genres.filter(Boolean) : [];

  return {
    ...item,
    name: meta.name || item.name,
    poster: normalizeImageUrl(meta.poster) || item.poster,
    poster_shape: meta.posterShape || item.poster_shape || "POSTER",
    background: normalizeImageUrl(meta.background) || normalizeImageUrl(meta.logo) || item.background,
    description: meta.description || item.description,
    release_info: meta.releaseInfo || (meta.year ? String(meta.year) : item.release_info),
    imdb_rating: asRating(meta.imdbRating) ?? asRating(meta.rating) ?? item.imdb_rating,
    genres: genres.length ? genres : item.genres,
    addon_base_url: !isPlaceholderAddonUrl(addonBaseUrl) ? addonBaseUrl : item.addon_base_url,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function prepareLibraryMetadataContext() {
  if (!state.nuvio.session?.access_token) {
    logLine("Nuvio is not connected, so library metadata enrichment from addons is skipped.");
    return null;
  }

  try {
    const context = await loadEpisodeMappingContext();
    if (!context.addons.length) {
      logLine("No compatible Nuvio metadata addon was found, so library items will use Simkl metadata only.");
      return null;
    }
    context.metaTimeoutMs = EPISODE_REMAP_META_TIMEOUT_MS;
    logLine(`Enriching library items from Nuvio metadata addon "${getSelectedMetadataAddonName()}".`);
    return context;
  } catch (error) {
    logLine(`Library metadata enrichment unavailable: ${error.message}`);
    return null;
  }
}

async function enrichLibraryItemsWithAddonMeta(items, context) {
  if (!context?.addons?.length || !items.length) return items;

  const enrichedItems = await mapWithConcurrency(items, LIBRARY_META_ENRICH_CONCURRENCY, async (item) => {
    const result = await fetchLibraryMeta(item.content_id, item.content_type, context, item._metaIds || []);
    if (!result) return item;
    return applyAddonMetaToLibraryItem(item, result);
  });

  const enrichedCount = enrichedItems.filter((item, index) => {
    const before = items[index];
    return Boolean(
      (item.poster && !before.poster)
      || (item.background && !before.background)
      || (item.description && !before.description)
      || (!isPlaceholderAddonUrl(item.addon_base_url) && isPlaceholderAddonUrl(before.addon_base_url)),
    );
  }).length;
  logLine(`Enriched ${enrichedCount}/${items.length} library items with Nuvio addon metadata.`);
  return enrichedItems;
}

async function fetchSeriesMeta(contentId, contentType, context) {
  const typeCandidates = unique([contentType, inferCanonicalMetaType(contentType), "series", "tv"]);
  const metaIdCandidates = unique([
    contentId,
    barePrefixedId(contentId, "mal"),
    barePrefixedId(contentId, "tvdb"),
    barePrefixedId(contentId, "tmdb"),
    barePrefixedId(contentId, "simkl"),
  ].filter(Boolean));

  for (const type of typeCandidates) {
    for (const id of metaIdCandidates) {
      const meta = await fetchMetaFromAddons(context, type, id);
      if (Array.isArray(meta?.videos) && meta.videos.length) {
        return meta;
      }
    }
  }
  return null;
}

async function getAddonEpisodes(contentId, contentType, context, showLabel = "") {
  const cacheKey = `${context.effectiveProfileId}|${contentType}|${contentId}`;
  if (addonEpisodeCache.has(cacheKey)) return addonEpisodeCache.get(cacheKey);
  const meta = await fetchSeriesMeta(contentId, contentType, context);
  const episodes = mapAddonVideosToEpisodeEntries(meta?.videos || []);
  addonEpisodeCache.set(cacheKey, episodes);
  if (!episodes.length) {
    noteEpisodeRemapFallback(context, "metadata", contentId, showLabel || contentId);
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

async function getSimklEpisodes(showLookupId, context, showLabel = "") {
  if (!showLookupId) return [];
  if (simklEpisodeCache.has(showLookupId)) return simklEpisodeCache.get(showLookupId);
  let data = [];
  try {
    const response = await simklRequestWithTimeout(
      `/shows/${encodeURIComponent(showLookupId)}/seasons`,
      {},
      context?.simklTimeoutMs || EPISODE_REMAP_SIMKL_TIMEOUT_MS,
    );
    data = response.data;
  } catch {
    noteEpisodeRemapFallback(context, "simkl", showLookupId, showLabel || showLookupId);
    simklEpisodeCache.set(showLookupId, []);
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
  simklEpisodeCache.set(showLookupId, entries);
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
    const addonEpisodes = await getAddonEpisodes(
      params.contentId,
      params.contentType,
      context,
      params.show?.title || params.contentId,
    );
    if (!episodeMapperCanContinue(context)) return null;

    const addonHasEpisode = addonEpisodes.some(
      (item) => item.season === params.season && item.episode === params.episode,
    );
    if (!addonEpisodes.length || addonHasEpisode) {
      episodeMappingCache.set(cacheKey, null);
      return null;
    }

    const showLookupId = resolveShowLookupId(params.show?.ids, params.contentId);
    const simklEpisodes = await getSimklEpisodes(
      showLookupId,
      context,
      params.show?.title || params.contentId,
    );
    if (!episodeMapperCanContinue(context)) return null;

    if (simklEpisodes.length) {
      mapped = reverseRemapEpisodeByTitleOrIndex({
        requestedSeason: params.season,
        requestedEpisode: params.episode,
        requestedTitle: params.episodeTitle,
        addonEpisodes,
        simklEpisodes,
      });
    }
    if (!mapped) {
      noteEpisodeRemapFallback(
        context,
        "unmapped",
        params.contentId,
        params.show?.title || params.contentId,
      );
    }
  } catch {
    noteEpisodeRemapFallback(
      context,
      "error",
      params.contentId,
      params.show?.title || params.contentId,
    );
    mapped = null;
  }

  episodeMappingCache.set(cacheKey, mapped);
  return mapped;
}

function noteEpisodeRemapFallback(context, type, showKey, showTitle) {
  if (!context) return;
  context.fallbackStats ||= {};
  context.fallbackShows ||= {};
  if (!context.fallbackShows[type]) {
    context.fallbackShows[type] = new Map();
  }
  const key = String(showKey || showTitle || "unknown");
  if (context.fallbackShows[type].has(key)) return;
  context.fallbackShows[type].set(key, showTitle || showKey || "unknown");
  context.fallbackStats[type] = (context.fallbackStats[type] || 0) + 1;
}

function logEpisodeRemapFallbackSummary(context) {
  const stats = context?.fallbackStats || {};
  const total = Object.values(stats).reduce((sum, value) => sum + Number(value || 0), 0);
  if (!total) return;

  const showMaps = context?.fallbackShows || {};
  const describeShows = (type) => {
    const shows = showMaps[type];
    if (!shows?.size) return "";
    const titles = [...shows.values()].slice(0, 5);
    const suffix = shows.size > titles.length ? ` (+${shows.size - titles.length} more)` : "";
    return `: ${titles.join(", ")}${suffix}`;
  };

  const parts = [
    ["metadata", "shows missing addon metadata"],
    ["simkl", "shows with Simkl season lookup issues"],
    ["unmapped", "shows without confident remap"],
    ["error", "shows with remap errors"],
    ["budget", "remap time budget hit"],
  ]
    .filter(([key]) => stats[key])
    .map(([key, label]) => {
      if (key === "budget") return label;
      const showCount = showMaps[key]?.size || stats[key];
      return `${showCount} ${label}${describeShows(key)}`;
    });

  logLine(`Episode remapping notes: ${parts.join("; ")}. Affected shows kept Simkl numbering.`);
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
    logLine(`Episode remapping exceeded the ${formatRemapTimeout(budgetMs)} guard. Continuing this sync without remapping the remaining episodes.`);
  }
  return false;
}

function reverseRemapEpisodeByTitleOrIndex({
  requestedSeason,
  requestedEpisode,
  requestedTitle,
  addonEpisodes,
  simklEpisodes,
}) {
  return remapEpisodeBetweenLists({
    requestedSeason,
    requestedEpisode,
    requestedTitle,
    requestedVideoId: null,
    sourceEpisodes: simklEpisodes,
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


function resolveShowLookupId(ids, contentId) {
  const lookup = lookupFromIds(ids);
  if (lookup) return lookup;
  const parsed = parseContentId(contentId);
  return parsed.imdb || parsed.simkl || parsed.slug || "";
}

function lookupFromIds(ids) {
  if (!ids) return "";
  // Prefer Simkl-native IDs for Simkl season lookups.
  if (ids.simkl !== undefined && ids.simkl !== null && String(ids.simkl).trim()) return String(ids.simkl);
  if (typeof ids.slug === "string" && ids.slug.trim()) return ids.slug.trim();
  const rawImdb = String(ids.imdb || "").trim();
  if (/^tt\d+$/i.test(rawImdb)) return rawImdb;
  if (/^\d+$/i.test(rawImdb)) return `tt${rawImdb}`;
  if (ids.tmdb !== undefined && ids.tmdb !== null && String(ids.tmdb).trim()) return `tmdb:${ids.tmdb}`;
  return "";
}

function parseContentId(value) {
  const text = String(value || "").trim();
  if (/^tt\d+$/i.test(text)) return { imdb: text };
  const imdbMatch = text.match(/^imdb:(tt\d+)$/i);
  if (imdbMatch) return { imdb: imdbMatch[1] };
  const simklMatch = text.match(/^simkl:([0-9]+)$/i);
  if (simklMatch) return { simkl: simklMatch[1] };
  const tmdbMatch = text.match(/^tmdb:([0-9]+)$/i);
  if (tmdbMatch) return { tmdb: tmdbMatch[1] };
  const malMatch = text.match(/^mal:([0-9]+)$/i);
  if (malMatch) return { mal: malMatch[1] };
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

function countSimklWatchedShows(sourceItems, isAnime) {
  const watchedStatuses = isAnime ? SIMKL_WATCHED_STATUSES.anime : SIMKL_WATCHED_STATUSES.show;
  let showCount = 0;
  let episodeCount = 0;
  for (const item of sourceItems) {
    if (!watchedStatuses.has(item.status)) continue;
    showCount += 1;
    episodeCount += Number(item.watched_episodes_count) || 0;
  }
  return { showCount, episodeCount };
}

function countMappedShows(mappedEpisodes) {
  const episodesByShow = new Map();
  for (const item of mappedEpisodes) {
    episodesByShow.set(item.content_id, (episodesByShow.get(item.content_id) || 0) + 1);
  }
  return {
    showCount: episodesByShow.size,
    episodeCount: mappedEpisodes.length,
    episodesByShow,
  };
}

function logWatchedShowSummary(label, sourceItems, mappedEpisodes, isAnime) {
  const simkl = countSimklWatchedShows(sourceItems, isAnime);
  const mapped = countMappedShows(mappedEpisodes);
  logLine(
    `Mapped ${mapped.showCount} ${label} (${mapped.episodeCount} watched episodes). `
    + `Simkl reports ${simkl.showCount} ${label} with ${simkl.episodeCount} watched episodes.`,
  );
  if (isAnime && simkl.showCount !== mapped.showCount) {
    logLine(`  ${simkl.showCount} Simkl anime entries map into ${mapped.showCount} unified Nuvio series IDs.`);
  }

  const watchedStatuses = isAnime ? SIMKL_WATCHED_STATUSES.anime : SIMKL_WATCHED_STATUSES.show;
  const mappedBySimklKey = new Map();
  for (const item of mappedEpisodes) {
    const key = item._simkl_key || item.content_id;
    mappedBySimklKey.set(key, (mappedBySimklKey.get(key) || 0) + 1);
  }

  let mismatches = 0;
  for (const item of sourceItems) {
    if (!watchedStatuses.has(item.status)) continue;
    const show = item.show || item;
    const expected = Number(item.watched_episodes_count) || 0;
    if (!expected) continue;
    const simklKey = String(show?.ids?.simkl || show?.title || "");
    const actual = mappedBySimklKey.get(simklKey) || 0;
    if (actual === expected) continue;
    if (mismatches < 5) {
      logLine(`  ${show.title || simklKey}: Simkl ${expected} watched, mapped ${actual}.`);
    }
    mismatches += 1;
  }
  if (mismatches > 5) {
    logLine(`  ${mismatches - 5} more ${label} with episode count differences.`);
  }
}

function logLibrarySummary(movies, shows, anime) {
  if (movies.length) logLine(`Mapped ${movies.length} movie library items.`);
  if (shows.length) logLine(`Mapped ${shows.length} TV show library items.`);
  if (anime.length) logLine(`Mapped ${anime.length} anime library items.`);
}

async function pullSimklPlan(options) {
  const remaps = parseRemaps(options.idRemaps);
  const plan = {
    history: [],
    progress: [],
    library: [],
    skipped: [],
    fallbackIds: 0,
    remappedEpisodes: 0,
  };
  const episodeMapper = await prepareEpisodeMapper();

  if (options.syncHistory) {
    const [movies, shows, anime] = await Promise.all([
      fetchAllSimkl(["/sync/all-items/movies/completed"], {}, "completed movies", options),
      fetchAllSimkl(["/sync/all-items/shows"], SIMKL_SHOW_HISTORY_PARAMS, "watched shows", options),
      fetchAllSimkl(["/sync/all-items/anime"], SIMKL_ANIME_HISTORY_PARAMS, "anime watched items", options),
    ]);

    const mappedMovies = mapWatchedMovies(movies, remaps, plan);
    const mappedShows = await mapWatchedShows(shows, remaps, plan, episodeMapper, false);
    const mappedAnime = await mapWatchedShows(anime, remaps, plan, episodeMapper, true);

    plan.history.push(...mappedMovies, ...mappedShows, ...mappedAnime);
    plan.history = dedupeBy(plan.history, watchedKey, "watched_at");

    logLine(`Mapped ${mappedMovies.length} completed movies.`);
    logWatchedShowSummary("TV shows", shows, mappedShows, false);
    logWatchedShowSummary("anime", anime, mappedAnime, true);
    logLine(`Total watched history: ${plan.history.length} items for Nuvio.`);
  }

  if (options.syncProgress) {
    const progress = await fetchAllSimklOptional(["/sync/playback"], {}, "playback progress", options);
    const movies = progress.filter((item) => item.type === "movie");
    const episodes = progress.filter((item) => item.type === "episode");

    plan.progress.push(...(await mapPlayback(movies, "movie", remaps, plan, options, episodeMapper)));
    plan.progress.push(...(await mapPlayback(episodes, "episode", remaps, plan, options, episodeMapper)));
    plan.progress = dedupeBy(plan.progress, progressKey, "last_watched");
    logLine(`Mapped ${plan.progress.length} continue-watching entries for Nuvio.`);
  }

  if (options.syncWatchlist) {
    const [movies, shows, anime] = await Promise.all([
      fetchAllSimkl(["/sync/all-items/movies"], SIMKL_LIBRARY_MOVIE_PARAMS, "movie library items", options),
      fetchAllSimkl(["/sync/all-items/shows"], SIMKL_LIBRARY_SHOW_PARAMS, "show library items", options),
      fetchAllSimkl(["/sync/all-items/anime"], SIMKL_LIBRARY_ANIME_PARAMS, "anime library items", options),
    ]);

    const movieLibrary = mapLibraryItems(filterSimklByStatus(movies, SIMKL_LIBRARY_STATUSES.movie), "watchlist", "movie", remaps, plan);
    const showLibrary = mapLibraryItems(filterSimklByStatus(shows, SIMKL_LIBRARY_STATUSES.show), "watchlist", "show", remaps, plan);
    const animeLibrary = mapLibraryItems(filterSimklByStatus(anime, SIMKL_LIBRARY_STATUSES.anime), "watchlist", "anime", remaps, plan);

    plan.library.push(...movieLibrary, ...showLibrary, ...animeLibrary);

    const libraryMetadataContext = await prepareLibraryMetadataContext();
    if (libraryMetadataContext && plan.library.length) {
      plan.library = await enrichLibraryItemsWithAddonMeta(plan.library, libraryMetadataContext);
    }
  }

  plan.library = dedupeBy(plan.library, (item) => item.content_id, "added_at");
  if (plan.library.length) {
    const libraryMovies = plan.library.filter((item) => item.content_type === "movie");
    const libraryShows = plan.library.filter((item) => item.content_type === "series");
    const libraryAnime = plan.library.filter((item) => item.content_type === "anime");
    logLibrarySummary(libraryMovies, libraryShows, libraryAnime);
    logLine(`Total library items: ${plan.library.length}. Existing Nuvio library will be merged before full replace.`);
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
    // Simkl /sync/all-items/movies returns { movie: { title, ids: {...} }, last_watched_at, ... }
    const movie = item.movie || item;
    if (!movie || !movie.ids) {
      skip(plan, movie?.title || "movie", "missing movie or IDs");
      continue;
    }
    const id = resolveContentId(movie.ids, "movie", remaps, plan);
    if (!id) {
      skip(plan, movie.title || "movie", "missing movie ID");
      continue;
    }
    // Only include completed items (watched)
    if (item.status === "completed") {
      mapped.push({
        content_id: id.value,
        content_type: "movie",
        title: movie.title || "Untitled movie",
        watched_at: toEpochMs(item.last_watched_at || item.last_updated_at),
      });
    }
  }
  return mapped;
}

async function mapWatchedShows(items, remaps, plan, episodeMapper, isAnime = false) {
  const mapped = [];
  const watchedStatuses = isAnime ? SIMKL_WATCHED_STATUSES.anime : SIMKL_WATCHED_STATUSES.show;
  for (const item of items) {
    if (!watchedStatuses.has(item.status)) continue;
    const show = item.show || item;
    if (!show || !show.ids) {
      skip(plan, show?.title || "show", "missing show or IDs");
      continue;
    }
    const standaloneAnime = isAnime && isStandaloneSimklAnime(item.anime_type);
    const id = resolveContentId(show.ids, isAnime ? "anime" : "show", remaps, plan, { animeType: item.anime_type });
    if (!id) {
      skip(plan, show.title || "show", "missing show ID");
      continue;
    }

    // Process watched episodes from seasons structure
    if (item.seasons && Array.isArray(item.seasons)) {
      for (const season of item.seasons) {
        if (!Array.isArray(season.episodes)) continue;
        for (const episode of season.episodes) {
          if (!episode.watched_at && !episode.last_watched_at) continue;
          const localSeason = asNumber(season.number);
          const localEpisode = asNumber(episode.number ?? episode.episode);
          if (localSeason === null || localEpisode === null) {
            skip(plan, show.title || id.value, "missing season or episode number");
            continue;
          }

          const episodeTitle = episode.title || null;
          const animeCoords = isAnime ? resolveSimklAnimeEpisodeCoords(item, season, episode) : null;
          let targetSeason = localSeason;
          let targetEpisode = localEpisode;
          let targetTitle = episodeTitle;
          let wasRemapped = false;

          if (animeCoords && animeCoords.source !== "simkl") {
            targetSeason = animeCoords.season;
            targetEpisode = animeCoords.episode;
            wasRemapped = targetSeason !== localSeason || targetEpisode !== localEpisode;
          } else if (!standaloneAnime && episodeMapper) {
            const remapped = await resolveImportedEpisodeMapping(episodeMapper, {
              contentId: id.value,
              contentType: isAnime ? "anime" : "series",
              show,
              season: localSeason,
              episode: localEpisode,
              episodeTitle,
            });
            if (remapped) {
              targetSeason = remapped.season;
              targetEpisode = remapped.episode;
              targetTitle = remapped.title || episodeTitle;
              wasRemapped = targetSeason !== localSeason || targetEpisode !== localEpisode;
            }
          }

          if (wasRemapped) plan.remappedEpisodes += 1;
          mapped.push({
            content_id: id.value,
            content_type: isAnime ? "anime" : "series",
            title: targetTitle
              ? `${show.title || (isAnime ? "Anime" : "Series")} - ${targetTitle}`
              : `${show.title || (isAnime ? "Anime" : "Series")} S${pad2(targetSeason)}E${pad2(targetEpisode)}`,
            season: targetSeason,
            episode: targetEpisode,
            watched_at: toEpochMs(episode.watched_at || episode.last_watched_at || item.last_updated_at),
            _remapped_from: wasRemapped ? `S${pad2(localSeason)}E${pad2(localEpisode)}` : null,
            _simkl_key: String(show.ids?.simkl || show.title || id.value),
          });
        }
      }
    } else if (Number(item.watched_episodes_count) > 0) {
      skip(plan, show.title || id.value, "missing per-episode watch data from Simkl");
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
      // Movie progress
      const movie = entry.movie || entry;
      const id = resolveContentId(movie?.ids, "movie", remaps, plan);
      if (!id) {
        skip(plan, movie?.title || "movie progress", "missing movie ID");
        continue;
      }
      const runtime = movie?.runtime || (options.estimateDuration ? 90 : 0);
      const duration = durationMs(runtime, 0);
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
        last_watched: toEpochMs(entry.last_watched_at || entry.paused_at || entry.watched_at || entry.updated_at),
        _title: movie?.title || id.value,
      });
      continue;
    }

    // Episode progress
    const show = entry.show || entry;
    const id = resolveContentId(show?.ids, "show", remaps, plan);
    const seasonNumber = asNumber(entry.season !== undefined ? entry.season : entry.episode?.season);
    const episodeNumber = asNumber(
      entry.number !== undefined ? entry.number : entry.episode?.number ?? entry.episode?.episode,
    );
    if (!id || seasonNumber === null || episodeNumber === null) {
      skip(plan, show?.title || entry.episode?.title || "episode progress", "missing show ID or episode number");
      continue;
    }
    const runtime = entry.runtime || show?.runtime || (options.estimateDuration ? 45 : 0);
    const duration = durationMs(runtime, 0);
    if (!duration) {
      skip(plan, entry.episode?.title || entry.title || id.value, "missing episode runtime");
      continue;
    }
    const episodeTitle = entry.title || entry.episode?.title || null;
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

async function mapLibraryItems(items, source, contentKind, remaps, plan, episodeMapper) {
  const mapped = [];
  for (const item of items) {
    const media = contentKind === "movie" ? item.movie || item : item.show || item;
    const animeOptions = contentKind === "anime" ? { animeType: item.anime_type } : undefined;
    const id = resolveContentId(media?.ids, contentKind, remaps, plan, animeOptions);
    if (!id) {
      skip(plan, media?.title || source, `missing ${contentKind} ID`);
      continue;
    }
    const metaIds = idCandidates(media?.ids || {}, contentKind, animeOptions).map((candidate) => candidate.value);
    const genres = normalizeSimklGenres(media?.genres);
    mapped.push({
      content_id: id.value,
      content_type: contentKind === "movie" ? "movie" : contentKind === "anime" ? "anime" : "series",
      name: media.title || "Untitled",
      poster: pickSimklImageUrl(media, ["poster", "thumb"]),
      poster_shape: "POSTER",
      background: pickSimklImageUrl(media, ["fanart", "backdrop", "background"]),
      description: media.overview || null,
      release_info: media.year ? String(media.year) : null,
      imdb_rating: asRating(media.rating),
      genres,
      addon_base_url: null,
      added_at: toEpochMs(item.listed_at || item.collected_at || item.updated_at),
      _source: source,
      _metaIds: unique([id.value, ...metaIds]),
    });
  }
  return mapped;
}

function isStandaloneSimklAnime(animeType) {
  return ["movie", "ova", "ona", "special", "music video"].includes(String(animeType || "").toLowerCase());
}

function resolveSimklAnimeEpisodeCoords(simklItem, season, episode) {
  const localSeason = asNumber(season?.number);
  const localEpisode = asNumber(episode?.number ?? episode?.episode);
  if (localSeason === null || localEpisode === null) return null;

  const tvdbSeason = asNumber(episode?.tvdb?.season);
  const tvdbEpisode = asNumber(episode?.tvdb?.episode ?? episode?.tvdb?.number);
  if (tvdbSeason !== null && tvdbEpisode !== null) {
    return { season: tvdbSeason, episode: tvdbEpisode, source: "tvdb" };
  }

  const mappedSeasons = Array.isArray(simklItem?.mapped_tvdb_seasons)
    ? simklItem.mapped_tvdb_seasons
      .map((value) => asNumber(value))
      .filter((value) => value !== null && value > 0)
    : [];
  if (mappedSeasons.length === 1 && localSeason === 1) {
    return { season: mappedSeasons[0], episode: localEpisode, source: "mapped_tvdb_seasons" };
  }
  if (mappedSeasons.length > 1 && localSeason >= 1 && localSeason <= mappedSeasons.length) {
    return { season: mappedSeasons[localSeason - 1], episode: localEpisode, source: "mapped_tvdb_seasons" };
  }

  return { season: localSeason, episode: localEpisode, source: "simkl" };
}

function resolveContentId(ids, kind, remaps, plan, options = {}) {
  const candidates = idCandidates(ids, kind, options);
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

function idCandidates(ids = {}, kind, options = {}) {
  const list = [];
  const standaloneAnime = kind === "anime" && isStandaloneSimklAnime(options.animeType);

  if (kind === "anime") {
    if (!standaloneAnime && ids.tvdb) {
      list.push({
        value: `tvdb:${ids.tvdb}`,
        fallback: false,
        remapKeys: [`tvdb:${ids.tvdb}`],
      });
    }
    if (ids.mal) {
      list.push({
        value: `mal:${ids.mal}`,
        fallback: false,
        remapKeys: [`mal:${ids.mal}`],
      });
    }
  }

  const rawImdb = String(ids.imdb || "").trim();
  const imdb = /^tt\d+$/i.test(rawImdb)
    ? rawImdb
    : /^\d+$/i.test(rawImdb)
      ? `tt${rawImdb}`
      : "";
  if (imdb) {
    list.push({
      value: imdb,
      fallback: false,
      remapKeys: [`imdb:${imdb}`],
    });
  }
  if (ids.tmdb) {
    list.push({ value: `tmdb:${ids.tmdb}`, fallback: false });
  }
  if (kind !== "anime" && ids.mal) {
    list.push({
      value: `mal:${ids.mal}`,
      fallback: false,
      remapKeys: [`mal:${ids.mal}`],
    });
  }
  if (ids.simkl) {
    list.push({
      value: `simkl:${ids.simkl}`,
      fallback: true,
      remapKeys: [`simkl:${kind}:${ids.simkl}`],
    });
  }
  if (ids.tvdb && kind !== "anime") {
    list.push({ value: `tvdb:${ids.tvdb}`, fallback: true, usable: false });
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
    const merged = mergeNuvioLibrary(existing, plan.library);
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

function mergeLibraryMetadata(merged, existingItems) {
  if (!existingItems.length) return;
  const existingMap = new Map();
  for (const item of existingItems) {
    if (item.content_id) existingMap.set(item.content_id, item);
  }
  for (const item of merged) {
    const existing = existingMap.get(item.content_id);
    if (!existing) continue;
    if (!item.poster && existing.poster) item.poster = existing.poster;
    if (!item.background && existing.background) item.background = existing.background;
    if (!item.description && existing.description) item.description = existing.description;
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
    addon_base_url: isPlaceholderAddonUrl(item.addon_base_url) ? null : item.addon_base_url,
    added_at: Number(item.added_at || Date.now()),
  };
}

function pickLibraryField(incoming, existing) {
  if (incoming === null || incoming === undefined || incoming === "") return existing ?? incoming;
  if (Array.isArray(incoming) && !incoming.length && Array.isArray(existing) && existing.length) return existing;
  if (isPlaceholderAddonUrl(incoming)) return existing ?? null;
  return incoming;
}

function mergeLibraryItemFields(existing, incoming) {
  return {
    content_id: incoming.content_id,
    content_type: incoming.content_type || existing.content_type,
    name: pickLibraryField(incoming.name, existing.name),
    poster: pickLibraryField(incoming.poster, existing.poster),
    poster_shape: incoming.poster_shape || existing.poster_shape || "POSTER",
    background: pickLibraryField(incoming.background, existing.background),
    description: pickLibraryField(incoming.description, existing.description),
    release_info: pickLibraryField(incoming.release_info, existing.release_info),
    imdb_rating: pickLibraryField(incoming.imdb_rating, existing.imdb_rating),
    genres: Array.isArray(incoming.genres) && incoming.genres.length ? incoming.genres : (existing.genres || []),
    addon_base_url: pickLibraryField(incoming.addon_base_url, existing.addon_base_url),
    added_at: Math.max(Number(existing.added_at || 0), Number(incoming.added_at || 0)),
  };
}

function mergeNuvioLibrary(existingItems, importedItems) {
  const byId = new Map(
    (Array.isArray(existingItems) ? existingItems : [])
      .map(cleanNuvioLibraryItem)
      .filter((item) => item.content_id)
      .map((item) => [item.content_id, item]),
  );

  for (const raw of importedItems) {
    const incoming = cleanNuvioLibraryItem(stripPrivateFields(raw));
    if (!incoming.content_id) continue;
    const prior = byId.get(incoming.content_id);
    byId.set(incoming.content_id, prior ? mergeLibraryItemFields(prior, incoming) : incoming);
  }

  return [...byId.values()].sort((left, right) => Number(right.added_at || 0) - Number(left.added_at || 0));
}

function stripPrivateFields(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith("_")));
}

async function previewSync() {
  clearLog();
  const options = readOptions();
  validateSyncInputs(options, false);
  logLine("Preview pull started.");
  lastPlan = await pullSimklPlan(options);
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
  lastPlan = await pullSimklPlan(options);
  updateStats(lastPlan);
  renderPreview(lastPlan, 1);
  await pushPlanToNuvio(lastPlan);
  logLine("Sync complete.");
  toast("Sync complete.");
}

function validateSyncInputs(options, requireNuvio) {
  if (!state.simkl.token?.access_token) {
    throw new Error("Connect Simkl before pulling data.");
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

function normalizeSimklClientId(value) {
  const clientId = String(value || "").trim();
  return /^[a-f0-9]{64}$/i.test(clientId) ? clientId : "";
}

function extractSimklClientIdFromUrl(value) {
  try {
    return normalizeSimklClientId(new URL(value).searchParams.get("client_id"));
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

function disconnectSimkl() {
  state.simkl.token = null;
  state.simkl.clientId = "";
  pendingSimklState = null;
  pendingSimklClientId = "";
  saveState();
  updateAuthStatus();
  logLine("Simkl disconnected locally.");
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
  state.nuvio.metadataAddons = [];
  state.nuvio.metadataAddonUrl = "";
  clearEpisodeMappingCaches();
  saveState();
  renderProfiles();
  renderMetadataAddons();
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
      if (!(action === dom.startSimklLogin && simklPending)) {
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

bind(dom.startSimklLogin, toggleSimklConnection);
bind(dom.loginNuvio, toggleNuvioConnection);
bind(dom.previewSync, previewSync, "Loading preview...", "Preview ready");
bind(dom.runSync, runSync, "Syncing...", "Synced");

dom.copyLog.addEventListener("click", async () => {
  await navigator.clipboard.writeText(dom.log.textContent);
  toast("Log copied.");
});

[
  dom.syncHistory,
  dom.syncProgress,
  dom.syncWatchlist,
  dom.syncCollection,
  dom.metadataAddonSelect,
].filter(Boolean).forEach((field) => {
  field.addEventListener("change", () => {
    readOptions();
    clearEpisodeMappingCaches();
  });
  field.addEventListener("input", readOptions);
});

if (dom.profileSelect) {
  dom.profileSelect.addEventListener("change", async () => {
    readOptions();
    try {
      setBusy(true);
      await loadNuvioMetadataAddons();
    } catch (error) {
      logLine(`Error: ${error.message}`);
      toast(error.message);
    } finally {
      setBusy(false);
      updateAuthStatus();
    }
  });
}

if (dom.previewPrev) {
  dom.previewPrev.addEventListener("click", () => renderPreviewPage(previewPage - 1));
}
if (dom.previewNext) {
  dom.previewNext.addEventListener("click", () => renderPreviewPage(previewPage + 1));
}

window.addEventListener("online", () => toast("Network is back."));
window.addEventListener("offline", () => toast("You appear to be offline."));
window.addEventListener("message", (event) => {
  handleSimklOauthPayload(event.data, event.origin || "");
});
if ("BroadcastChannel" in window) {
  simklBroadcastChannel = new BroadcastChannel("nuvio-simkl-bridge.simkl-oauth");
  simklBroadcastChannel.addEventListener("message", (event) => {
    handleSimklOauthPayload(event.data, "");
  });
}
window.addEventListener("beforeunload", () => {
  if (simklBroadcastChannel) {
    simklBroadcastChannel.close();
  }
});

hydrateForm();
