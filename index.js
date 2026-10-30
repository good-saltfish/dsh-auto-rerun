/**
 * dsh-auto-rerun — 模型断连自动重跑
 *
 * Host-side plugin. Two cooperating layers, both keyed by agent and all
 * bounded:
 *
 *   Layer A (request-level): listener on `agent/request-error`, registered
 *   downstream of the shipped @deepseek-ai/dsh-llm-retry. It *always* calls
 *   next() first — the built-in retry keeps handling transient blips — and
 *   only escalates when the chain comes back terminal (or no provider policy
 *   exists) AND the failure is disconnect-class. Escalation = own bounded
 *   retry counter with longer exponential backoff, returning { kind: 'retry' }.
 *
 *   Layer B (turn-level): on a terminal `agent/error` that is disconnect-class,
 *   schedule one `agent.followup()` after a short delay so the agent opens a
 *   new turn and resumes the interrupted work. Consecutive reruns are capped
 *   and reset by a completed turn / a real user message / disposal. This layer
 *   is *visible* (it posts a message into the session), so rate-limit codes are
 *   excluded by default: they get the silent Layer A retry instead of a nudge.
 *
 * Design notes:
 *   - Normal-mode sessions: llm-retry covers short windows; this plugin
 *     covers the long tail (proxy/VPN restart, minutes-long outage).
 *   - Always-mode sessions: transparent pass-through (user opted into the
 *     built-in infinite retry).
 *   - Non-disconnect failures (auth, quota, invalid request, context overflow,
 *     code/protocol bugs) are never retried or rerun.
 *   - Backoff precedence in Layer A: the provider's structured Retry-After,
 *     then its own in-message hint ("queued, retry in ~3s"), then the class
 *     window (long/silent for rate limits, short for network blips).
 *   - Everything is state-only (no transcript writes) and fully
 *     cleanup-registered; disable the plugin and all timers/listeners stop.
 *     The optional `logFile` is the one opt-in disk write, for manual testing.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const name = "auto-rerun";
const inject = ["agents"];

/** Defaults; the bundle's cordis.patch.yml entry overrides these. */
const DEFAULTS = {
  enabled: true,

  // Layer A — request-level long-tail takeover.
  request: { enabled: true },
  retries: 3,              // max Layer A retries per incident (per agent)
  initialDelayMs: 5000,
  maxDelayMs: 60000,
  backoffFactor: 2,
  jitterRatio: 0.2,
  // Rate limits (HTTP 429 / RATE_LIMIT) are not network blips: a per-minute
  // token budget only clears after tens of seconds, so the short network
  // window above is useless for them. These override the Layer A delay for
  // rate-limit failures only; they stay silent (no visible Layer B nudge).
  rateLimitInitialDelayMs: 30000,
  rateLimitMaxDelayMs: 180000,
  // Providers often put their real backoff instruction in the failure text
  // instead of a Retry-After header ("Qoder is busy — the request was queued
  // (retry in ~3s)"). Such a hint beats the class default: a queue-busy
  // signal clears in seconds, so waiting the 30s+ rate-limit window on it
  // both stalls the turn and burns the whole Layer A budget without ever
  // reaching a healthy upstream. Set false to ignore in-message hints.
  honorMessageRetryHint: true,
  messageHintMinMs: 1000,
  messageHintMaxMs: 60000,
  // Fast hint probes get their OWN budget instead of eating the patient
  // `retries` one: a busy route can stay busy for minutes, and a count budget
  // spent on minute-long waits is what makes the turn drop. See `busy` in
  // Layer A — congestion is retried on a time budget, not a strike count.
  busyRouteBudgetMs: 600000,

  // busyRouteBudgetMs 无上限地一直重连，直到上游答应用户或失败被判定为"一定
  // 报错"（死路：401/403、订阅过期、key 失效、额度永久耗尽——见 deadRouteReason，
  // 那一支仍会立刻停手/换路线）。这正是"免费模型容易堵但想死磕同一个模型直到
  // 跑通"的场景。退避仍有封顶（rateLimitMaxDelayMs / messageHintMaxMs），所以
  // "无限"是几十秒一次的礼貌节奏，不是把免费端点打爆（那本身会招来 429）。
  // false = 维持 1.5.1 行为：拥塞吃 busyRouteBudgetMs 空闲预算、断连吃 retries
  // 计数预算，烧完就（在开了 modelFallback 时）换路线或收工。
  retryUntilSuccess: true,
  // An upper bound for the mode above, so "retry until it runs" cannot turn a
  // permanently broken route into a silently stuck session: after this long
  // without a single completed request the plugin stops taking over and lets
  // the failure close the turn (the user sees the error and can act). The
  // cadence stays capped, so this is a real wall-clock limit, not a guess.
  retryUntilSuccessMaxMs: 7200000,

  // Layer C — model fallback (选模型重试). A route that keeps failing is not
  // worth infinite patience: after `fallbackAfterFailures` consecutive failed
  // attempts on one route the request is replayed on another provider/model.
  // The switch is recorded through the host's Session controller as a durable
  // `model/selection` event, so prompt assembly, the request header, the
  // host's own "model changed" notice and the GUI model picker all agree on
  // the new route — the user can switch back at any time and the choice
  // survives a reload. Without that service the same route is applied to the
  // next request through the `agent/request` waterfall instead.
  modelFallback: { enabled: false },
  // Explicit priority list of "provider/model" routes, tried before the live
  // catalog (`ctx.llm.listProviders()` / `listModels()`). Empty = catalog
  // order, which also keeps the quota of a different provider independent.
  fallbackRoutes: [],
  fallbackAfterFailures: 2,
  // How long one incident may stay on the same route before a fallback is
  // allowed. Without this, `retryUntilSuccess` would never arm Layer C at all
  // (it retries forever, so the count budget never runs out) and turning the
  // panel's fallback switch on would silently do nothing.
  fallbackAfterMs: 300000,
  fallbackMaxSwitches: 2,
  // true = any model may be the fallback (the turn stays alive, and the switch
  // is visible in the transcript and the model picker); false = only the same
  // model id on another provider, so answer quality cannot change silently.
  fallbackAnyModel: true,
  // Two failures further apart than this do not belong to the same incident:
  // the route was evidently serving requests in between, so the count and
  // idle budgets start over. Keeps a healthy route's single hiccup from being
  // refused by a stale budget from twenty minutes ago.
  incidentGapMs: 60000,

  // Layer B — turn-level auto-rerun (visible: it posts a message).
  rerun: { enabled: true },
  reruns: 1,               // max consecutive auto-reruns per incident
  rerunDelayMs: 3000,
  // Codes that must NOT trigger a visible rerun. They still get the silent
  // Layer A retry; they just never interrupt the user with a nudge.
  // HTTP 429 counts as RATE_LIMIT.
  rerunExcludeCodes: ["RATE_LIMIT"],

  // Failure classification: disconnect-class only.
  // `codes` replaces the built-in list; `extraCodes` extends it.
  codes: undefined,        // e.g. ["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"]
  extraCodes: [],          // e.g. ["UPSTREAM_OVERLOADED"]
  statusSet: [408, 425, 429, 500, 502, 503, 504],
  messagePattern: undefined, // optional custom regex source string
  lang: "zh",              // "zh" | "en" — rerun prompt language
  debug: false,
  // Optional absolute path: append one line per decision (mount, takeover,
  // backoff, budget exhaustion, rerun scheduled/fired/skipped) so a manual
  // test can be watched live. Off by default — the plugin stays memory-only.
  logFile: undefined,
  // Where the control panel's runtime toggles are persisted. Left empty it
  // derives from `logFile` (same directory, `auto-rerun-settings.json`);
  // otherwise it falls back to `${DSH_HOME:-~/.dsh}/auto-rerun-settings.json`,
  // which is the only portable location a host-only plugin can assume. Set
  // `settingsFile: ""` (empty string) to keep the toggles in memory instead.
  settingsFile: undefined,
};

/**
 * DSH's own data directory, resolved the way the host resolves it: `$DSH_HOME`
 * when set, `~/.dsh` otherwise. The plugin must not import the host's
 * `@deepseek-ai/dsh-home-paths` (a host-only plugin cannot assume it resolves
 * from its own install directory), so the same rule is inlined here.
 */
function dshHome() {
  const fromEnv = typeof process?.env?.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
  if (fromEnv) return fromEnv;
  try {
    return join(homedir(), ".dsh");
  } catch {
    return undefined;
  }
}

const BUILTIN_CODES = ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"];

/** The disconnect-message pattern used when `messagePattern` is unset (and the
 *  fallback when a hand-written one does not compile). */
const BUILTIN_MESSAGE_PATTERN =
  "econn|etimedout|epipe|ehostunreach|enetunreach|eai_again|socket hang up|fetch failed" +
  "|network|disconnect|connection (reset|refused|closed|aborted|timed out)" +
  "|timed out|timeout|rate.?limit|too many requests|overload|overloaded" +
  "|service unavailable|bad gateway|gateway timeout|upstream error|stream (error|aborted|cancel)";

/** Milliseconds per retry-hint unit, as providers spell them. */
const HINT_UNIT_MS = {
  ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  "毫秒": 1, "秒": 1000, "秒钟": 1000, "分": 60000, "分钟": 60000,
};

/** Numeric config coercion that also accepts an explicit 0. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A duration the way a log line should read it. Millisecond-precision values
 * keep their unit: `Math.round(40 / 1000)` is "0s", which would make a short
 * test window look like an already-expired one.
 */
function humanMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * The running build's version, read from the sibling package.json so the mount
 * line says which revision is actually live (a stale module cache and a real
 * reload look identical in the log otherwise). Never throws.
 */
let versionCache;
function pluginVersion() {
  // The control panel asks for the status every couple of seconds; a sync read
  // per poll would be a silly amount of file traffic for a constant.
  if (versionCache !== undefined) return versionCache;
  try {
    versionCache = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))?.version ?? "unknown";
  } catch {
    versionCache = "unknown";
  }
  return versionCache;
}

/** "provider/model" → `{ provider, model }`; provider ids never contain "/". */
function parseRoute(text) {
  const value = String(text ?? "").trim();
  const cut = value.indexOf("/");
  if (cut <= 0 || cut === value.length - 1) return undefined;
  return { provider: value.slice(0, cut), model: value.slice(cut + 1) };
}

function routeKey(route) {
  return route ? `${route.provider}/${route.model}` : "";
}

const NETWORK_ERRNO = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "ECONNABORTED", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

function mergeConfig(raw) {
  const cfg = { ...DEFAULTS, ...raw };
  cfg.request = { ...DEFAULTS.request, ...(raw?.request ?? {}) };
  cfg.rerun = { ...DEFAULTS.rerun, ...(raw?.rerun ?? {}) };
  const codes = Array.isArray(cfg.codes) && cfg.codes.length ? cfg.codes : BUILTIN_CODES;
  cfg.codeSet = new Set([...codes, ...(Array.isArray(cfg.extraCodes) ? cfg.extraCodes : [])].map((c) => String(c).toUpperCase()));
  cfg.statusList = new Set((Array.isArray(cfg.statusSet) ? cfg.statusSet : DEFAULTS.statusSet).map(Number));
  cfg.rerunExcludeSet = new Set(
    (Array.isArray(cfg.rerunExcludeCodes) ? cfg.rerunExcludeCodes : DEFAULTS.rerunExcludeCodes)
      .map((c) => String(c).toUpperCase()),
  );
  const patternSource = typeof cfg.messagePattern === "string" && cfg.messagePattern
    ? cfg.messagePattern
    : BUILTIN_MESSAGE_PATTERN;
  // A hand-written pattern can be invalid ("*(bad") shaped wrong. A throw here
  // would abort apply() and silently take the whole retry layer down, so fall
  // back to the built-in pattern instead and keep the plugin mounted.
  try {
    cfg.messageRegex = new RegExp(patternSource, "i");
  } catch (cause) {
    cfg.messagePatternError = String(cause?.message ?? cause);
    cfg.messageRegex = new RegExp(BUILTIN_MESSAGE_PATTERN, "i");
  }
  if (!Number.isFinite(cfg.retries) || cfg.retries < 0) cfg.retries = DEFAULTS.retries;
  if (!Number.isFinite(cfg.reruns) || cfg.reruns < 0) cfg.reruns = DEFAULTS.reruns;
  if (!Number.isFinite(cfg.rerunDelayMs) || cfg.rerunDelayMs < 0) cfg.rerunDelayMs = DEFAULTS.rerunDelayMs;
  cfg.initialDelayMs = Math.max(0, Number(cfg.initialDelayMs) || DEFAULTS.initialDelayMs);
  cfg.maxDelayMs = Math.max(cfg.initialDelayMs, Number(cfg.maxDelayMs) || DEFAULTS.maxDelayMs);
  cfg.backoffFactor = Math.max(1, Number(cfg.backoffFactor) || DEFAULTS.backoffFactor);
  cfg.jitterRatio = Math.min(0.9, Math.max(0, Number(cfg.jitterRatio) || 0));
  cfg.rateLimitInitialDelayMs = Math.max(0, Number(cfg.rateLimitInitialDelayMs) || DEFAULTS.rateLimitInitialDelayMs);
  cfg.rateLimitMaxDelayMs = Math.max(cfg.rateLimitInitialDelayMs, Number(cfg.rateLimitMaxDelayMs) || DEFAULTS.rateLimitMaxDelayMs);
  cfg.honorMessageRetryHint = cfg.honorMessageRetryHint !== false;
  cfg.messageHintMinMs = Math.max(0, num(cfg.messageHintMinMs, DEFAULTS.messageHintMinMs));
  cfg.messageHintMaxMs = Math.max(cfg.messageHintMinMs, num(cfg.messageHintMaxMs, DEFAULTS.messageHintMaxMs));
  cfg.busyRouteBudgetMs = Math.max(0, num(cfg.busyRouteBudgetMs, DEFAULTS.busyRouteBudgetMs));
  cfg.retryUntilSuccess = cfg.retryUntilSuccess !== false;
  cfg.retryUntilSuccessMaxMs = Math.max(0, Math.round(num(cfg.retryUntilSuccessMaxMs, DEFAULTS.retryUntilSuccessMaxMs)));
  cfg.modelFallback = { ...DEFAULTS.modelFallback, ...(raw?.modelFallback ?? {}) };
  cfg.modelFallback.enabled = cfg.modelFallback.enabled !== false;
  cfg.fallbackRoutes = (Array.isArray(cfg.fallbackRoutes) ? cfg.fallbackRoutes : DEFAULTS.fallbackRoutes)
    .map((r) => parseRoute(r))
    .filter(Boolean);
  cfg.fallbackAfterFailures = Math.max(1, Math.round(num(cfg.fallbackAfterFailures, DEFAULTS.fallbackAfterFailures)));
  cfg.fallbackAfterMs = Math.max(0, Math.round(num(cfg.fallbackAfterMs, DEFAULTS.fallbackAfterMs)));
  cfg.fallbackMaxSwitches = Math.max(0, Math.round(num(cfg.fallbackMaxSwitches, DEFAULTS.fallbackMaxSwitches)));
  cfg.fallbackAnyModel = cfg.fallbackAnyModel !== false;
  cfg.incidentGapMs = Math.max(0, Math.round(num(cfg.incidentGapMs, DEFAULTS.incidentGapMs)));
  // `DSH_AUTO_RERUN_LOG` is the escape hatch for a local manual test: set it to
  // a path and the plugin writes its decision log there without editing config.
  const envLog = typeof process?.env?.DSH_AUTO_RERUN_LOG === "string" ? process.env.DSH_AUTO_RERUN_LOG.trim() : "";
  cfg.logFile = typeof cfg.logFile === "string" && cfg.logFile.trim()
    ? cfg.logFile.trim()
    : envLog || undefined;
  const explicitSettings = typeof cfg.settingsFile === "string" ? cfg.settingsFile.trim() : undefined;
  if (explicitSettings) {
    cfg.settingsFile = explicitSettings;
  } else if (explicitSettings === "") {
    // `settingsFile: ""` is a deliberate opt-out: keep the toggles in memory.
    cfg.settingsFile = undefined;
  } else if (cfg.logFile) {
    cfg.settingsFile = join(dirname(cfg.logFile), "auto-rerun-settings.json");
  } else {
    const home = dshHome();
    cfg.settingsFile = home ? join(home, "auto-rerun-settings.json") : undefined;
  }
  return cfg;
}

function errorText(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return [error.message, error.cause?.message, error.body, error.response?.statusText]
    .filter(Boolean).join(" | ");
}

/**
 * JSON for diagnostics, never a throw.
 *
 * Failures reach this plugin as provider error objects that routinely carry
 * `cause` chains and response/socket references; `JSON.stringify` on one of
 * those throws `TypeError: Converting circular structure to JSON`. This runs
 * inside the `agent/request-error` listener *before* the retry decision, so a
 * throw there would abort the very hook that is supposed to save the turn —
 * a debug line must never be able to do that.
 *
 * @param {unknown} value - anything worth printing.
 * @param {number} [max] - truncate the result to this many characters.
 * @returns {string} JSON text, or a `String(value)` fallback for cyclic input.
 */
function safeJson(value, max = 300) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.slice(0, max);
  } catch {
    try { return String(value).slice(0, max); } catch { return "[unprintable]"; }
  }
}

/**
 * Is this failure disconnect-class (worth an automatic retry / rerun)?
 * `code` is the loop's classified code or an errno; message/status fill gaps.
 */
function isDisconnectClass(cfg, { code, message, status, error } = {}) {
  const upper = code ? String(code).toUpperCase() : undefined;
  if (upper && (cfg.codeSet.has(upper) || NETWORK_ERRNO.has(upper))) return true;
  const numeric = Number(status ?? error?.status ?? error?.statusCode ?? error?.response?.status);
  if (Number.isFinite(numeric) && cfg.statusList.has(numeric)) return true;
  const text = message ?? errorText(error);
  if (text && cfg.messageRegex.test(text)) return true;
  // providerRetryAfterMs present means the upstream asked to be retried.
  if (Number.isFinite(error?.providerRetryAfterMs) && error.providerRetryAfterMs > 0) return true;
  return false;
}

/**
 * Should this failure be kept *silent* (no visible Layer B rerun)?
 * Returns the matched code when the failure is excluded from visible reruns.
 */
function rerunBlockedCode(cfg, { code, status, error } = {}) {
  const upper = code ? String(code).toUpperCase() : undefined;
  if (upper && cfg.rerunExcludeSet.has(upper)) return upper;
  const numeric = Number(status ?? error?.status ?? error?.statusCode ?? error?.response?.status);
  if (numeric === 429 && cfg.rerunExcludeSet.has("RATE_LIMIT")) return "RATE_LIMIT";
  return undefined;
}

/**
 * Is this failure a rate limit? Those need a much longer backoff window than
 * a network blip and are handled silently.
 */
function isRateLimit(cfg, { code, status, error } = {}) {
  const upper = code ? String(code).toUpperCase() : undefined;
  if (upper === "RATE_LIMIT") return true;
  const numeric = Number(status ?? error?.status ?? error?.statusCode ?? error?.response?.status);
  if (numeric === 429) return true;
  const text = error?.message ?? "";
  return /rate.?limit|too many requests|tpm exhausted|quota_exceeded/i.test(text);
}

function describe(cfg, { code, message, status, error } = {}) {
  const parts = [];
  if (code) parts.push(String(code));
  const numeric = status ?? error?.status ?? error?.statusCode;
  if (numeric) parts.push(`status ${numeric}`);
  const text = (message ?? errorText(error)).slice(0, 160);
  if (text) parts.push(text);
  return parts.filter(Boolean).join(" · ") || "unknown error";
}

function localDelay(cfg, attempt, override) {
  const base = override?.initialDelayMs ?? cfg.initialDelayMs;
  const cap = override?.maxDelayMs ?? cfg.maxDelayMs;
  const exponential = Math.min(base * cfg.backoffFactor ** Math.min(attempt - 1, 16), cap);
  const jitter = 1 - cfg.jitterRatio + 2 * cfg.jitterRatio * Math.random();
  return Math.min(Math.round(exponential * jitter), cap);
}

/**
 * Read a provider's own backoff instruction out of the failure text.
 *
 * Some providers answer with a queue/busy signal that carries its own retry
 * delay instead of a Retry-After header, e.g.
 *   `Qoder is busy — the request was queued (retry in ~3s)`
 *   `{"error":{"message":"Rate limit reached. Please try again in 2.5s"}}`
 *   `retry_after: 5`
 *   `请 3 秒后重试`
 * Returns milliseconds, or undefined when the text carries no usable hint.
 * Longest unit alternative first, so `ms` never wins over `m`/`seconds`.
 */
function messageRetryHintMs(text) {
  if (!text || typeof text !== "string") return undefined;
  const units = "milliseconds?|msecs?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|毫秒|秒钟|秒|分钟|分";
  const rules = [
    // "retry in ~3s", "please try again in 2 seconds", "resend after 500ms"
    { re: new RegExp(`(?:retry|try again|retry again|resend)[^\\d\\n]{0,24}?(\\d+(?:\\.\\d+)?)\\s*(${units})`, "i") },
    // "retry_after: 5" / "retry-after=5" — a bare number means seconds.
    { re: /retry[_-]?after["'\s:=]+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m)?/i, fallbackUnit: "s" },
    // Chinese word order: "请 3 秒后重试" / "2 分钟后再试"
    { re: /(\d+(?:\.\d+)?)\s*(毫秒|秒钟|秒|分钟|分)[^\n]{0,8}?(?:后)?(?:重试|再试)/, fallbackUnit: "秒" },
  ];
  for (const { re, fallbackUnit } of rules) {
    const match = re.exec(text);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    const factor = HINT_UNIT_MS[String(match[2] ?? fallbackUnit ?? "").toLowerCase()];
    if (!factor) continue;
    return Math.round(value * factor);
  }
  return undefined;
}

/**
 * Clamp a provider hint into the configured window, then jitter it.
 * `escalations` is how many times this incident already used the hint: the
 * first probe honours the provider's own cadence, later ones back off by
 * `backoffFactor` (capped) so a long congestion is not polled every 3s.
 */
function hintDelay(cfg, hintMs, escalations = 0) {
  const cap = Math.min(cfg.messageHintMaxMs, cfg.rateLimitMaxDelayMs);
  const grown = hintMs * Math.pow(cfg.backoffFactor, Math.min(Math.max(escalations, 0), 8));
  const base = Math.min(Math.max(grown, cfg.messageHintMinMs), cap);
  const jitter = 1 - cfg.jitterRatio + 2 * cfg.jitterRatio * Math.random();
  return Math.min(Math.round(base * jitter), cap);
}

/**
 * Best-effort model label for diagnostics: the request-error payload does not
 * always carry one at the top level, so fall back through the nested shapes
 * before giving up.
 */
function pickModel(payload) {
  const candidates = [
    payload?.model,
    payload?.request?.model,
    payload?.failure?.model,
    payload?.options?.model,
    payload?.request?.options?.model,
    payload?.agent?.model,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "unknown";
}

function cancellableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function rerunPrompt(cfg, n, label) {
  if (cfg.lang === "en") {
    return `[auto-rerun ${n}] The model connection was interrupted (${label}). `
      + "Resume the unfinished work from where it stopped — do not repeat steps that already completed; "
      + "if everything was actually finished, just reply with a short completion summary.";
  }
  return `[auto-rerun ${n}] 刚才与模型的连接中断（${label}）。`
    + "请检查此前的任务进度并从中断处继续未完成的工作，不要重复已完成的步骤；"
    + "如果任务实际已全部完成，请直接回复简要的结果摘要。";
}

/**
 * Why a candidate message would be REJECTED when the session is replayed, or
 * `null` when it is safe to persist. Mirrors the host's own cold-restore rule
 * (`assertMessageEventShape`) for `user/message` — that validator throws
 * "… lacks an identified message" for a missing/empty `id`, and also rejects a
 * wrong `role`, a non-array `content`, and a `source` without a non-empty
 * `kind`. Writing anything it rejects is not a cosmetic bug: the whole session
 * fails to load afterwards, history included.
 *
 * @param {unknown} message - the object about to be handed to the host.
 * @returns {string|null} human-readable defect, or null when well-formed.
 */
function unidentifiedReason(message) {
  if (!message || typeof message !== "object") return "not an object";
  if (typeof message.id !== "string" || message.id === "") return "message.id must be a non-empty string";
  if (message.role !== "user") return 'message.role must be "user"';
  if (!Array.isArray(message.content)) return "message.content must be an array";
  const kind = message.source?.kind;
  if (typeof kind !== "string" || kind === "") return "message.source.kind must be a non-empty string";
  return null;
}

/**
 * Build the injected message as a COMPLETE `UserMessage`.
 *
 * `agent.followup()` persists whatever object it is handed. Handing it a bare
 * `{ content, source }` writes a `user/message` event with no `message.id` and
 * no `message.role`; the cold-restore validator (`assertMessageEventShape`)
 * then rejects the WHOLE session with "session event at seq N lacks an
 * identified message" and the history becomes unopenable.
 *
 * Preferred path: the shipped `createUserMessage()` from `@deepseek-ai/dsh-llm`,
 * which supplies the UUID and role exactly as the core does. It is resolved
 * lazily so a missing specifier can never break plugin load. The identity is
 * backfilled rather than trusted, because a message that reaches the session
 * without an id is unrecoverable afterwards — the repair is cheap, the
 * corruption is not.
 */
async function buildUserMessage({ content, source }) {
  // `source` must stay an object with a non-empty kind, or the validator
  // rejects the event for the same reason it rejects a missing id.
  const safeSource =
    source && typeof source === "object" && typeof source.kind === "string" && source.kind !== ""
      ? source
      : { kind: "auto-rerun", ...(source && typeof source === "object" ? source : {}) };
  const safeContent = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
  let message;
  try {
    const llm = await import("@deepseek-ai/dsh-llm");
    if (typeof llm?.createUserMessage === "function") {
      message = llm.createUserMessage({ content: safeContent, source: safeSource });
    }
  } catch {
    // fall through to the hand-built shape
  }
  if (unidentifiedReason(message)) {
    // Either the host module is unavailable or it handed back something
    // incomplete: fill the identity in rather than persisting a defect.
    message = {
      ...message,
      id: typeof message?.id === "string" && message.id !== "" ? message.id : randomUUID(),
      role: "user",
      content: Array.isArray(message?.content) ? message.content : safeContent,
      source: message?.source && typeof message.source === "object" ? message.source : safeSource,
    };
  }
  return message;
}

/**
 * The ONLY place this plugin injects a message into a live session.
 *
 * Every current and future injection must go through here so the
 * identified-message invariant has one choke point instead of one per call
 * site: it builds a complete `UserMessage`, refuses to persist anything the
 * cold-restore validator would reject (fail loud, lose the rerun, keep the
 * session readable), and only then hands it to `agent.followup()`.
 *
 * @param {{ followup: (message: object) => unknown }} agent - host agent handle.
 * @param {{ content: Array<object>, source: Record<string, unknown> }} input - durable content plus its source.
 * @returns {Promise<object>} the message that was injected.
 * @throws {Error} when the built message would not survive session replay.
 */
async function admitFollowup(agent, input) {
  const message = await buildUserMessage(input);
  const problem = unidentifiedReason(message);
  if (problem) {
    throw new Error(`auto-rerun: refusing to inject an unidentified message (${problem})`);
  }
  agent.followup(message);
  return message;
}

// Test seams: let a local smoke test exercise the message shape, the
// retry-hint parser and the model label without the host module table
// (see dev/smoke.mjs).
export {
  buildUserMessage as __buildUserMessage,
  admitFollowup as __admitFollowup,
  unidentifiedReason as __unidentifiedReason,
  messageRetryHintMs as __messageRetryHintMs,
  hintDelay as __hintDelay,
  pickModel as __pickModel,
  parseRoute as __parseRoute,
  mergeConfig as __mergeConfig,
};

function apply(ctx, rawConfig = {}) {
  if (!rawConfig || rawConfig.enabled === false) {
    ctx.logger?.info?.("auto-rerun: disabled by config");
    return;
  }
  const cfg = mergeConfig(rawConfig);
  if (cfg.messagePatternError) {
    ctx.logger?.warn?.(`auto-rerun: messagePattern did not compile (${cfg.messagePatternError}); using the built-in pattern`);
  }
  const toFile = (level, msg) => {
    if (!cfg.logFile) return;
    try {
      appendFileSync(cfg.logFile, `${new Date().toISOString()} [${level}] ${msg}\n`);
    } catch { /* logging must never break the agent loop */ }
  };
  const log = {
    info: (msg) => { ctx.logger?.info?.(`auto-rerun: ${msg}`); toFile("info", msg); },
    warn: (msg) => { ctx.logger?.warn?.(`auto-rerun: ${msg}`); toFile("warn", msg); },
    dbg: (msg) => {
      if (!cfg.debug) return;
      ctx.logger?.info?.(`auto-rerun[debug]: ${msg}`);
      toFile("debug", msg);
    },
  };

  // ---------------------------------------------------------------------
  // Control panel (right sidebar). Everything the panel shows or flips goes
  // through the host routes below, reading and writing this very `cfg`, so the
  // panel can never disagree with the listener that does the retrying.
  // ---------------------------------------------------------------------
  const stats = {
    since: Date.now(), takeovers: 0, refusals: 0, reruns: 0, switches: 0, deadRoutes: 0,
  };
  const feed = { lines: [], max: 200 };
  const record = (level, msg) => {
    feed.lines.push(`${new Date().toISOString().slice(11, 19)} ${level.padEnd(4)} ${msg}`);
    if (feed.lines.length > feed.max) feed.lines.splice(0, feed.lines.length - feed.max);
  };
  for (const level of ["info", "warn", "dbg"]) {
    const raw = log[level];
    log[level] = (msg) => { record(level, msg); raw(msg); };
  }

  /** Runtime-tunable keys. Anything not listed stays config-file only, so a
   *  panel request can never rewrite routes/patterns and break the wiring. */
  const SETTINGS = {
    retryUntilSuccess: (v) => v !== false,
    retryUntilSuccessMaxMs: (v) => Math.max(0, Math.round(num(v, cfg.retryUntilSuccessMaxMs))),
    debug: (v) => v === true,
    honorMessageRetryHint: (v) => v !== false,
    retries: (v) => Math.max(0, Math.round(num(v, cfg.retries))),
    reruns: (v) => Math.max(0, Math.round(num(v, cfg.reruns))),
    rerunDelayMs: (v) => Math.max(0, Math.round(num(v, cfg.rerunDelayMs))),
    busyRouteBudgetMs: (v) => Math.max(0, Math.round(num(v, cfg.busyRouteBudgetMs))),
    incidentGapMs: (v) => Math.max(0, Math.round(num(v, cfg.incidentGapMs))),
    fallbackAfterFailures: (v) => Math.max(1, Math.round(num(v, cfg.fallbackAfterFailures))),
    fallbackAfterMs: (v) => Math.max(0, Math.round(num(v, cfg.fallbackAfterMs))),
    fallbackMaxSwitches: (v) => Math.max(0, Math.round(num(v, cfg.fallbackMaxSwitches))),
    fallbackAnyModel: (v) => v !== false,
    modelFallback: (v) => v === true,
    "modelFallback.enabled": (v) => v === true,
  };
  // `key in SETTINGS` would also admit Object.prototype names ("constructor",
  // "toString", "__proto__"), letting a request write junk onto cfg. Keys are
  // checked against the own-key set instead.
  const SETTING_KEYS = new Set(Object.keys(SETTINGS));

  function writeSetting(key, value) {
    if (!SETTING_KEYS.has(key)) throw new Error(`unknown setting: ${key}`);
    const next = SETTINGS[key](value);
    if (key === "modelFallback" || key === "modelFallback.enabled") cfg.modelFallback.enabled = next;
    else cfg[key] = next;
    return next;
  }
  function settingsSnapshot() {
    return {
      retryUntilSuccess: cfg.retryUntilSuccess,
      retryUntilSuccessMaxMs: cfg.retryUntilSuccessMaxMs,
      debug: cfg.debug,
      honorMessageRetryHint: cfg.honorMessageRetryHint,
      retries: cfg.retries,
      reruns: cfg.reruns,
      rerunDelayMs: cfg.rerunDelayMs,
      busyRouteBudgetMs: cfg.busyRouteBudgetMs,
      incidentGapMs: cfg.incidentGapMs,
      fallbackAfterFailures: cfg.fallbackAfterFailures,
      fallbackAfterMs: cfg.fallbackAfterMs,
      fallbackMaxSwitches: cfg.fallbackMaxSwitches,
      fallbackAnyModel: cfg.fallbackAnyModel,
      modelFallback: cfg.modelFallback.enabled,
      logFile: cfg.logFile ?? null,
      settingsFile: cfg.settingsFile ?? null,
    };
  }
  function persistSettings() {
    if (!cfg.settingsFile) return;
    try {
      mkdirSync(dirname(cfg.settingsFile), { recursive: true });
      writeFileSync(cfg.settingsFile, `${JSON.stringify({ settings: settingsSnapshot(), savedAt: new Date().toISOString() }, null, 2)}\n`);
    } catch (cause) {
      log.dbg(`could not persist settings to ${cfg.settingsFile}: ${cause?.message ?? cause}`);
    }
  }
  function loadSettings() {
    if (!cfg.settingsFile) return;
    let saved;
    try {
      saved = JSON.parse(readFileSync(cfg.settingsFile, "utf8"))?.settings;
    } catch { return; }
    if (!saved || typeof saved !== "object") return;
    for (const [key, value] of Object.entries(saved)) {
      try { writeSetting(key, value); } catch { /* a key an older build wrote */ }
    }
  }
  loadSettings();

  function lastRouteLabel() {
    for (const st of agents.values()) if (st.seenRoute) return routeKey(st.seenRoute);
    return undefined;
  }
  function statusPayload() {
    return {
      mounted: true,
      version: pluginVersion(),
      config: settingsSnapshot(),
      stats: {
        since: stats.since,
        uptimeMs: Date.now() - stats.since,
        takeovers: stats.takeovers,
        refusals: stats.refusals,
        reruns: stats.reruns,
        switches: stats.switches,
        deadRoutes: stats.deadRoutes,
        agents: agents.size,
      },
      route: { label: lastRouteLabel() ?? null },
      log: feed.lines.slice(-60),
    };
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      req.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > 1 << 20) {
          settled = true;
          chunks.length = 0;
          reject(new Error("request body too large"));
          // Without this the body keeps streaming into a promise nobody awaits.
          try { req.destroy(); } catch { /* already gone */ }
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString("utf8").trim();
        if (!text) return resolve({});
        try { resolve(JSON.parse(text)); } catch { reject(new Error("request body is not valid JSON")); }
      });
      req.on("error", (cause) => {
        if (settled) return;
        settled = true;
        reject(cause);
      });
    });
  }
  function sendJson(res, status, body) {
    // The socket can already be gone (client navigated away, proxy timeout);
    // writing then throws out of an async handler as an unhandled rejection.
    try {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    } catch { /* the peer is gone; nothing to report it to */ }
  }

  async function handleApi(req, res) {
    const path = (req.url ?? "").split("?")[0].replace(/\/+$/, "");
    try {
      if (path === "/auto-rerun/api/status") {
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        return sendJson(res, 200, { ok: true, value: statusPayload() });
      }
      if (path === "/auto-rerun/api/config") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        const body = await readJson(req);
        const patch = body?.patch && typeof body.patch === "object" ? body.patch : body;
        const applied = {};
        for (const [key, value] of Object.entries(patch ?? {})) applied[key] = writeSetting(key, value);
        persistSettings();
        log.info(`control panel updated: ${Object.entries(applied).map(([k, v]) => `${k}=${v}`).join(", ")}`);
        return sendJson(res, 200, { ok: true, value: { applied, status: statusPayload() } });
      }
      return sendJson(res, 404, { ok: false, error: `no such endpoint: ${path}` });
    } catch (cause) {
      return sendJson(res, 400, { ok: false, error: String(cause?.message ?? cause) });
    }
  }

  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer", "connection"], (webCtx) => {
      const register = (path) => {
        try {
          return webCtx.webServer.register({
            kind: "exact",
            path,
            handler: (req, res) => {
              const rejection = webCtx.connection.requestRejection(req);
              if (rejection !== undefined) {
                sendJson(res, rejection, { ok: false, error: rejection === 401 ? "unauthorized" : "forbidden" });
                return;
              }
              handleApi(req, res).catch((cause) => sendJson(res, 500, { ok: false, error: String(cause?.message ?? cause) }));
            },
          });
        } catch (cause) {
          // A second mount with the same route must not take the whole plugin
          // down: the retrying half is the important half, the panel is optional.
          log.warn(`control panel route ${path} is already taken (${cause?.message ?? cause}); the panel api stays off`);
          return () => {};
        }
      };
      try {
        webCtx.effect(() => {
          const disposers = [register("/auto-rerun/api/status"), register("/auto-rerun/api/config")];
          return () => { for (const dispose of disposers) { try { dispose(); } catch { /* already gone */ } } };
        }, "auto-rerun: control panel api");
      } catch (cause) {
        log.warn(`control panel api could not be wired: ${cause?.message ?? cause}`);
      }
    });
  }

  log.info(`mounted v${pluginVersion()} (request takeover: ${cfg.request.enabled}, turn rerun: ${cfg.rerun.enabled}, retries=${cfg.retries}, reruns=${cfg.reruns}, silent-only codes: ${[...cfg.rerunExcludeSet].join(",") || "none"}, message hints: ${cfg.honorMessageRetryHint}${cfg.honorMessageRetryHint ? ` (${Math.round(cfg.messageHintMinMs / 1000)}-${Math.round(cfg.messageHintMaxMs / 1000)}s)` : ""}, ${cfg.retryUntilSuccess ? `retry-until-success: on (same model; stops only on dead-route errors or ${cfg.retryUntilSuccessMaxMs ? `${humanMs(cfg.retryUntilSuccessMaxMs)} without a completed request` : "never"})` : `busy-route budget: ${Math.round(cfg.busyRouteBudgetMs / 1000)}s`}, model fallback: ${cfg.modelFallback.enabled ? `after ${cfg.fallbackAfterFailures} failures or ${Math.round(cfg.fallbackAfterMs / 1000)}s, max ${cfg.fallbackMaxSwitches} switch(es)${cfg.fallbackAnyModel ? "" : ", same-model routes only"}${cfg.fallbackRoutes.length ? `, pinned: ${cfg.fallbackRoutes.map(routeKey).join(" ")}` : ""}` : "off"}, logFile: ${cfg.logFile ?? "off"}, settingsFile: ${cfg.settingsFile ?? "off"})`);

  /** Per-agent incident state: { retries, reruns, timers:Set<Timer>, rerunTimer } */
  const agents = new Map();
  const lifetime = new AbortController();

  function stateOf(id) {
    let st = agents.get(id);
    if (!st) {
      st = {
        retries: 0,
        busyLastAt: 0,
        reruns: 0,
        rerunTimer: null,
        // Layer C: consecutive failed attempts on the current route, how many
        // route switches this incident already made, the routes already tried,
        // the route the host itself assembled for the last request, and the
        // pending override used when no durable switch API is mounted.
        routeFails: 0,
        switches: 0,
        noFallbackLogged: false,
        previewLogged: false,
        lastFailAt: 0,
        // When the current incident's first failure arrived. `lastFailAt` is
        // refreshed on every takeover, so it cannot answer "how long has this
        // been going on"; this one survives across takeovers and is what lets
        // `retryUntilSuccess` eventually hand a hopeless route to Layer C.
        incidentStartedAt: 0,
        // When this agent's session last committed a durable `assistant/message`,
        // i.e. the last time the current route demonstrably ANSWERED. The gap
        // between two failures only proves the old incident is over if the
        // route served something in between: the plugin's own backoff can be
        // longer than `incidentGapMs` (a 180s rate-limit window against a 60s
        // gap), so "no failure for a while" is NOT proof of recovery. Reading it
        // that way would reset the incident clock on every long backoff and
        // leave both `retryUntilSuccessMaxMs` and `fallbackAfterMs` unable to
        // ever fire — the same class of mistake that made the 1.3.0 budget
        // refuse live reconnects.
        servedAt: 0,
        triedRoutes: new Set(),
        seenRoute: undefined,
        routeOverride: undefined,
        routeFrom: undefined,
        // Registration of the per-agent request guard; it outlives a reset
        // (it is a listener, not incident state) and dies with the agent.
        routeGuard: undefined,
      };
      agents.set(id, st);
    }
    return st;
  }

  function clearRerunTimer(st) {
    if (st.rerunTimer) {
      clearTimeout(st.rerunTimer);
      st.rerunTimer = null;
    }
  }

  function resetAgent(id, reason) {
    const st = agents.get(id);
    if (!st) return;
    clearRerunTimer(st);
    st.retries = 0;
    st.busyLastAt = 0;
    st.reruns = 0;
    // A new turn (or a real user message) starts a fresh incident: the caller
    // gets another chance at the route it originally picked.
    st.routeFails = 0;
    st.switches = 0;
    st.noFallbackLogged = false;
    st.lastFailAt = 0;
    st.incidentStartedAt = 0;
    st.servedAt = 0;
    st.triedRoutes.clear();
    st.routeOverride = undefined;
    st.routeFrom = undefined;
    log.dbg(`state reset for agent ${id} (${reason})`);
  }

  function dropAgent(id) {
    const st = agents.get(id);
    if (st) {
      clearRerunTimer(st);
      try { st.routeGuard?.(); } catch { /* the agent context is already gone */ }
    }
    agents.delete(id);
  }

  // ---------------------------------------------------------------- Layer C
  /**
   * Next candidate route for a switch, in priority order: the configured
   * `fallbackRoutes` first, then the live catalog (`listProviders` /
   * `listModels`) — a different provider also keeps its own quota, which is
   * what matters when the current route is throttled. Candidates already tried
   * in this incident are skipped, and every one is validated through
   * `resolveModelInfo` when the host exposes it: an unresolvable route would
   * fail prompt assembly instead of the request.
   */
  // Set by the last fallbackRouteFor() call so the caller can explain *why*
  // nothing was available (no catalog vs. no acceptable candidate).
  let lastCatalogReadable = false;

  // Every route this process has seen the Host assemble, keyed `provider/model`.
  // The fallback candidate source of last resort when the model directory is not
  // reachable from a plugin: a route the Host itself just used is known to exist
  // here, while a hand-written config can only guess.
  const knownRoutes = new Map();
  const KNOWN_ROUTES_MAX = 32;
  function rememberRoute(route) {
    if (!route?.provider || !route?.model) return;
    knownRoutes.set(routeKey(route), { provider: route.provider, model: route.model, lastSeenAt: Date.now() });
    if (knownRoutes.size > KNOWN_ROUTES_MAX) {
      const oldest = [...knownRoutes.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (oldest) knownRoutes.delete(oldest[0]);
    }
  }

  // Routes that answered with a permanent-looking refusal (expired
  // subscription, invalid key, no credits). Retrying them is pointless, so they
  // are remembered for a while and skipped as fallback candidates: the whole
  // point of a fallback is to land somewhere that works. 30 minutes is long
  // enough to keep a broken route out of the way and short enough that a fixed
  // key is picked up again without a restart.
  const DEAD_ROUTE_TTL_MS = 30 * 60 * 1000;
  const deadRoutes = new Map();
  const DEAD_ROUTE_CODES = /^(AUTH|AUTHENTICATION|UNAUTHORIZED|FORBIDDEN|PERMISSION|PERMISSION_DENIED|SUBSCRIPTION|SUBSCRIPTION_EXPIRED|INVALID_API_KEY|API_KEY_INVALID|BILLING|PAYMENT_REQUIRED|INSUFFICIENT_CREDITS)$/;
  const DEAD_ROUTE_TEXT = /subscription[^.\n]{0,40}expir|(invalid|incorrect|missing)[^.\n]{0,20}api[ _-]?key|api[ _-]?key[^.\n]{0,20}(invalid|missing|expired)|(no|insufficient|exhausted)[^.\n]{0,20}(credits|funds|balance)|(账户|余额|额度)[^。\n]{0,12}(不足|欠费|过期)|(订阅|套餐)[^。\n]{0,12}(过期|到期)/i;

  /**
   * A failure that says "this route will not work again" rather than "try
   * later". Kept apart from the disconnect class on purpose: 429/TPM exhaustion
   * is congestion (wait and retry), while an expired subscription or an invalid
   * key is a dead end — the live session log has both, and the dead end is what
   * silently ends turns.
   */
  function deadRouteReason(cfg, { code, message, status, error }) {
    const httpStatus = Number(status ?? error?.status);
    if (httpStatus === 401 || httpStatus === 403) return `HTTP ${httpStatus} from this route`;
    const codeText = String(code ?? error?.code ?? "").trim().toUpperCase();
    if (codeText && DEAD_ROUTE_CODES.test(codeText)) return `the route reported ${codeText}`;
    const text = [message, errorText(error)].filter(Boolean).join(" | ");
    if (text && DEAD_ROUTE_TEXT.test(text)) return "the route says its credentials or subscription are no good";
    return undefined;
  }

  // Hard ceiling, not just a TTL sweep. Expiring the old entries is only enough
  // while some of them HAVE expired: a provider that answers "invalid key" for
  // every model in its catalogue can blacklist dozens of routes inside one
  // minute, and none of them is 30 minutes old yet. The map then grows with
  // every new route name for the life of the process. Evicting the oldest entry
  // once the sweep leaves the map full keeps it bounded no matter what.
  const DEAD_ROUTES_MAX = 64;
  function markDeadRoute(route, reason) {
    if (!route?.provider || !route?.model) return;
    deadRoutes.set(routeKey(route), { until: Date.now() + DEAD_ROUTE_TTL_MS, reason });
    if (deadRoutes.size <= DEAD_ROUTES_MAX) return;
    const now = Date.now();
    for (const [key, entry] of deadRoutes) if (entry.until <= now) deadRoutes.delete(key);
    while (deadRoutes.size > DEAD_ROUTES_MAX) {
      const oldest = deadRoutes.keys().next();
      if (oldest.done) break;
      deadRoutes.delete(oldest.value);
    }
  }

  function isDeadRoute(route) {
    const entry = deadRoutes.get(routeKey(route));
    if (!entry) return false;
    if (entry.until <= Date.now()) {
      deadRoutes.delete(routeKey(route));
      return false;
    }
    return true;
  }

  async function fallbackRouteFor(from, st) {
    const seen = new Set([routeKey(from), ...st.triedRoutes]);
    // `fallbackAnyModel: false` restricts switching to the *same* model id on a
    // different provider. Same behaviour, a different quota bucket — the only
    // swap that cannot change answer quality. Off by default: a silent quality
    // change is worse than a visible one, but a dead turn is worse than both.
    const allowed = (route) => cfg.fallbackAnyModel || route.model === from.model;
    const pinned = [];
    for (const route of cfg.fallbackRoutes) {
      const key = routeKey(route);
      if (seen.has(key)) continue;
      if (isDeadRoute(route)) continue;
      seen.add(key);
      pinned.push({ ...route, source: "config" });
    }
    const catalog = [];
    let llm;
    try { llm = ctx.get?.("llm") ?? ctx.llm; } catch { llm = undefined; }
    const catalogReadable = !!llm && typeof llm.listProviders === "function" && typeof llm.listModels === "function";
    lastCatalogReadable = catalogReadable;
    if (catalogReadable) {
      try {
        for (const provider of (await llm.listProviders()) ?? []) {
          let models = [];
          try { models = (await llm.listModels(provider.id)) ?? []; } catch { models = []; }
          for (const model of models) {
            const route = { provider: provider.id, model: model.id };
            const key = routeKey(route);
            if (seen.has(key)) continue;
            if (isDeadRoute(route)) continue;
            if (!allowed(route)) continue;
            seen.add(key);
            catalog.push({ ...route, source: "catalog" });
          }
        }
      } catch (error) {
        log.dbg(`fallback catalog unavailable: ${errorText(error)}`);
      }
    }
    // No model directory from the Host (plain `ctx.get("llm")` is an internal
    // lookup, not a documented plugin surface). Routes that this very process
    // has already seen the Host assemble are the next best source: they are
    // known to exist here, which a hand-written config can only guess at.
    if (catalog.length === 0) {
      const recent = [...knownRoutes.values()]
        .filter((route) => !seen.has(routeKey(route)) && !isDeadRoute(route) && allowed(route))
        .sort((a, b) => (b.model === from.model) - (a.model === from.model) || b.lastSeenAt - a.lastSeenAt);
      for (const route of recent) {
        seen.add(routeKey(route));
        catalog.push({ provider: route.provider, model: route.model, source: "recent" });
      }
    }
    // Candidate order, and why:
    //   1. routes pinned in `fallbackRoutes` — an explicit human decision;
    //   2. the same model id on another provider — identical behaviour, a
    //      different quota bucket, which is what actually escapes a rate limit;
    //   3. routes this process has already seen the Host use — known to work
    //      here, unlike a catalogue entry whose subscription may have lapsed;
    //   4. everything else in the catalogue, most recent first.
    const candidateList = [
      ...pinned.map((route) => ({ ...route, group: 0, lastSeenAt: knownRoutes.get(routeKey(route))?.lastSeenAt ?? 0 })),
      ...catalog.map((route) => ({
        ...route,
        group: route.model === from.model ? 1 : knownRoutes.has(routeKey(route)) ? 2 : 3,
        lastSeenAt: knownRoutes.get(routeKey(route))?.lastSeenAt ?? 0,
      })),
    ].sort((a, b) => a.group - b.group || b.lastSeenAt - a.lastSeenAt);
    for (const route of candidateList) {
      if (llm && typeof llm.resolveModelInfo === "function") {
        try {
          await llm.resolveModelInfo(route.provider, route.model);
        } catch {
          log.dbg(`fallback candidate rejected by the host: ${routeKey(route)}`);
          continue;
        }
      }
      return route;
    }
    return undefined;
  }

  /**
   * Ordering matters. The host installs its own `agent/request` listener when it
   * creates the agent, and cordis runs prepended listeners newest-first — so a
   * listener registered at mount time ends up *inside* the host's and watches
   * its route be re-applied on the way out. Registering on the agent's own
   * context at the moment a switch first becomes necessary makes ours the
   * newest, therefore outermost, which is the only position from which a forced
   * route survives.
   */
  function ensureRouteGuard(agent, st) {
    if (st.routeGuard) return;
    const handler = async (payload, next) => {
      const config = await next();
      const override = st.routeOverride;
      if (!override || !config) return config;
      // Someone else (the user, or the host's own picker) moved the route: their
      // choice wins and the override is spent. A request that already runs on
      // the wanted route is left alone — the override stays armed for the rest
      // of the incident, so a route that keeps answering its old provider does
      // not silently fall back to the throttled one.
      if (st.routeFrom && routeKey(config) !== st.routeFrom && routeKey(config) !== routeKey(override)) {
        log.dbg(`fallback override dropped: the request route is ${routeKey(config)}`);
        st.routeOverride = undefined;
        st.routeFrom = undefined;
        return config;
      }
      if (routeKey(config) === routeKey(override)) return config;
      const { reasoningEffort: _inherited, ...rest } = config;
      return { ...rest, provider: override.provider, model: override.model };
    };
    // Register on both the agent's scoped context (the placement the Host's own
    // model-selection listeners use) and this plugin's context. Only one of them
    // needs to be admitted for the switch to hold; registering both costs two
    // no-op calls per request and removes the guess.
    const targets = [];
    if (agent?.ctx && typeof agent.ctx.on === "function") targets.push(["agent scope", agent.ctx]);
    if (typeof ctx.on === "function") targets.push(["plugin scope", ctx]);
    const disposes = [];
    for (const [label, target] of targets) {
      try {
        const dispose = target.on("agent/request", handler, { prepend: true });
        if (typeof dispose === "function") disposes.push(dispose);
      } catch (error) {
        log.dbg(`request guard registration failed on the ${label}: ${errorText(error)}`);
      }
    }
    if (disposes.length === 0) return;
    st.routeGuard = () => {
      for (const dispose of disposes) {
        try { dispose(); } catch { /* the context is already gone */ }
      }
    };
  }

  /**
   * Layer C can only do its job with the Host's own catalogue and selection API,
   * and neither is part of the documented plugin surface (`ctx.get` lookups are
   * how core code reaches them). Report what actually resolved once per mount,
   * at the first real incident, so a dead fallback is visible in the log instead
   * of silently doing nothing.
   */
  let wiringLogged = false;
  function logWiringOnce() {
    if (wiringLogged) return;
    wiringLogged = true;
    const lookup = (name) => {
      try { return typeof ctx.get === "function" ? ctx.get(name) : undefined; } catch { return undefined; }
    };
    const llm = lookup("llm");
    const sessions = lookup("sessionController")?.agents;
    if (cfg.modelFallback.enabled) {
      log.info(`model fallback wiring: llm catalog ${llm ? "reachable" : "missing"}, session selection ${sessions?.selectForNextRequest ? "reachable" : "missing"}, pinned routes: ${cfg.fallbackRoutes.length}`);
    }
  }

  /**
   * A dead fallback is invisible until the day it is needed. This runs the
   * candidate search once per process — without switching anything — and says
   * where the session *would* go. If the line reads "no candidate found", the
   * fix is to pin `fallbackRoutes` instead of waiting for a dead turn to learn
   * it the hard way.
   */
  let previewLogged = false;
  async function previewFallbackOnce(from, st) {
    // Per-agent, not per-process: with the flag on the shared closure one busy
    // agent's preview silenced every other agent's preview for the process
    // lifetime.
    if (st?.previewLogged || previewLogged || !cfg.modelFallback.enabled || !from?.provider || !from?.model) return;
    st.previewLogged = true;
    previewLogged = true;
    try {
      // Pinned routes are a deliberate manual choice: they take precedence over
    // the automatic guards (dead blacklist / allowed() / same-model), exactly
    // like an explicit whitelist entry. Guarding them again would make
    // `fallbackRoutes` un-forceable if a pinned route was ever auto-flagged.
    const first = await fallbackRouteFor(from, st);
      const scope = cfg.fallbackAnyModel ? "" : ", same-model routes only";
      log.info(first
        ? `model fallback preview for ${routeKey(from)}: would switch to ${routeKey(first)} (${first.source}${scope}), llm catalog: ${lastCatalogReadable ? "readable" : "missing"}`
        : `model fallback preview for ${routeKey(from)}: no candidate available (pinned: ${cfg.fallbackRoutes.length}${scope}, llm catalog: ${lastCatalogReadable ? "readable" : "missing"}) — pin fallbackRoutes if you want a route to fall back to`);
    } catch (error) {
      log.dbg(`fallback preview failed: ${errorText(error)}`);
    }
  }

  /**
   * Move this agent onto another route, in the order the Host supports it: the
   * Session controller's `selectForNextRequest` (session event + live selection
   * + the host's own "model changed" notice), else appending the same
   * `model/selection` event ourselves, else the plain `agent/request` override.
   * In every case the next request is forced by our own waterfall listener,
   * which sits in front of the host's model-selection one.
   */
  function applyRouteSwitch(agent, st, from, to, why) {
    const selection = { provider: to.provider, model: to.model };
    ensureRouteGuard(agent, st);
    let how;
    let hostOwned = false;
    // 1. The Session controller's own entry point: session event + live
    //    selection + the host's "[model changed: …]" notice.
    try {
      const api = typeof ctx.get === "function" ? ctx.get("sessionController")?.agents : undefined;
      if (api && typeof api.selectForNextRequest === "function") {
        api.selectForNextRequest(agent, selection);
        how = `recorded as a model/selection switch — the session continues on ${routeKey(to)}`;
        hostOwned = true;
      }
    } catch (error) {
      log.dbg(`session controller rejected the switch: ${errorText(error)}`);
    }
    // 2. No controller (this Host does not expose one): the GUI reads the same
    //    `model/selection` session event, so append it ourselves and let the
    //    `agent/request` override below carry the live effect.
    if (!how && typeof agent?.session?.append === "function") {
      try {
        agent.session.append("model/selection", selection);
        how = `recorded in the session log — the session continues on ${routeKey(to)}`;
      } catch (error) {
        log.dbg(`session log rejected the switch: ${errorText(error)}`);
      }
    }
    // The Host accepted the switch (`selectForNextRequest`), but its assembled
    // selection only refreshes at the next `system-prompt/assemble` — which runs
    // once per step, NOT inside this step's retry loop (the loop only calls
    // `refreshContext`, whose waterfall "does not rerun"). Dropping our override
    // here would let the Host's request-time listener re-impose the STALE
    // assembled route on every retry, burning the switch budget on the route we
    // just left. So the override stays armed in both cases; it self-clears once
    // the outgoing request actually carries `wanted` (the Host caught up), and
    // yields to any route someone else picked (actual !== routeFrom).
    st.routeOverride = selection;
    st.routeFrom = routeKey(from);
    // The new route has served nothing yet: an `assistant/message` delivered by
    // the route we just left is no proof about this one, and letting it stand
    // would let the incident-gap rule close the new route's incident early.
    st.servedAt = 0;
    st.triedRoutes.add(routeKey(to));
    // Our guard forces this route on the next request, so the next failure will
    // honestly be *this* route's. Record it now, otherwise a failure that
    // arrives before the next `agent/request` would still be attributed to the
    // route we just left (wrong "from" label, wrong dead-route bookkeeping).
    st.seenRoute = { provider: to.provider, model: to.model };
    stats.switches += 1;
    log.warn(`model fallback: ${routeKey(from)} → ${routeKey(to)} (${why}; ${how ?? "applied to the next request only"})`);
  }

  /**
   * The route a failure happened on: what the `agent/request` waterfall saw for
   * this agent, else the session's frozen request header, else the payload
   * sniff. Used for the log label and as the `from` side of a fallback switch —
   * `model=unknown` in older logs came from having only the payload to go on.
   */
  function routeOf(agent, st, provider, modelLabel) {
    if (st.seenRoute?.provider && st.seenRoute?.model) return st.seenRoute;
    try {
      const header = agent?.session?.requestHeader?.()?.config;
      if (header?.provider && header?.model) return { provider: header.provider, model: header.model };
    } catch { /* not every session exposes the header */ }
    return { provider, model: modelLabel };
  }

  // ------------------------------------------------- Layer C transport hook
  // `await next()` yields the config the machine would use (agent options on
  // the first request, the logged header afterwards), so this listener records
  // the route actually being requested and — only when the durable
  // `model/selection` switch was unavailable — replaces it for the retry.
  // Prepended so it runs outside the host's own model-selection listener,
  // which awaits the rest of the chain and then re-applies `selection.current`;
  // an outer listener is the only one that can win against that.
  const disposeRequestRoute = ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    if (!cfg.request.enabled) return config;
    const agent = payload?.agent;
    if (!agent || !config) return config;
    const st = stateOf(agent.id ?? "default");
    if (config.provider && config.model) {
      // A long quiet stretch AND proof the route answered SINCE that failure
      // means the old incident is over, so its budget must not be spent
      // against the next hiccup. The gap alone proves nothing: the plugin's
      // own backoff can be longer than `incidentGapMs` (a 180s rate-limit
      // window against a 60s gap), and then every single retry would look
      // like a fresh incident — clearing the clock that
      // `retryUntilSuccessMaxMs` and `fallbackAfterMs` measure, so neither
      // could ever fire. A `servedAt` older than `lastFailAt` is not proof
      // either: that success happened BEFORE the route went bad.
      if (st.servedAt > st.lastFailAt && st.lastFailAt && Date.now() - st.lastFailAt > cfg.incidentGapMs) {
        log.dbg(`incident closed after ${Math.round((Date.now() - st.lastFailAt) / 1000)}s with a served request in between — budgets reset`);
        st.retries = 0;
        st.routeFails = 0;
        st.busyLastAt = 0;
        st.lastFailAt = 0;
        st.incidentStartedAt = 0;
        st.noFallbackLogged = false;
        st.servedAt = 0;
      }
    }
    const override = st.routeOverride;
    let effective = config;
    if (override) {
      const actual = routeKey(config);
      const wanted = routeKey(override);
      if (actual === wanted) {
        st.routeOverride = undefined;
        st.routeFrom = undefined;
      } else if (st.routeFrom && actual !== st.routeFrom) {
        // The host — or the user — moved the route on its own; respect that.
        log.dbg(`fallback override dropped: the request route is ${actual}`);
        st.routeOverride = undefined;
        st.routeFrom = undefined;
      } else {
        // A different model may not accept the inherited effort; the loop
        // resolves the route's own default when none is supplied.
        const { reasoningEffort: _inherited, ...rest } = config;
        effective = { ...rest, provider: override.provider, model: override.model };
        if (cfg.debug) log.dbg(`fallback override applied: ${actual} → ${wanted}`);
      }
    }
    // Record the route the request ACTUALLY goes out on — after the override.
    // The Host rebuilds every request from its own header, so reading the
    // pre-override config here would label a forced request with the route we
    // left (and then blame, blacklist and "switch away from" that stale route
    // on the next failure).
    if (effective?.provider && effective?.model) {
      st.seenRoute = { provider: effective.provider, model: effective.model };
      rememberRoute(st.seenRoute);
      void previewFallbackOnce(st.seenRoute, st);
    }
    return effective;
  }, { prepend: true });

  // ---------------------------------------------------------------- Layer A
  const disposeRequestError = ctx.on("agent/request-error", async (payload, next) => {
    if (!cfg.request.enabled) return next();
    const { agent, provider, model, failure, retryPolicy, signal } = payload ?? {};
    if (cfg.debug) {
      log.dbg(`request-error payload keys: ${Object.keys(payload ?? {}).join(",")}; failure=${safeJson(failure)}`);
    }

    // Always-mode sessions opted into the built-in infinite retry — stay out.
    if (retryPolicy?.mode === "always") return next();

    // The built-in retry (upstream) owns transient-blip recovery. Escalate
    // only when the chain delegates back terminal.
    const downstream = await next();
    if (downstream?.kind === "retry") return downstream;

    if (!agent || !failure) return downstream;
    // A dead end is not congestion: an expired subscription or an invalid key
    // will answer the same way every time, so waiting is pointless and the turn
    // dies for nothing. Move the session to a working route instead, and let the
    // retry carry the next request (which now goes somewhere else).
    const deadReason = deadRouteReason(cfg, { code: failure.code, message: failure.message, status: failure.status, error: failure });
    if (deadReason) {
      const deadSt = stateOf(agent.id ?? "default");
      logWiringOnce();
      const deadRoute = routeOf(agent, deadSt, provider, pickModel(payload));
      markDeadRoute(deadRoute, deadReason);
      stats.deadRoutes += 1;
      log.warn(`route ${routeKey(deadRoute)} is unusable (${deadReason}) — looking for another route`);
      if (cfg.modelFallback.enabled && deadSt.switches < cfg.fallbackMaxSwitches) {
        const to = await fallbackRouteFor(deadRoute, deadSt);
        if (to) {
          applyRouteSwitch(agent, deadSt, deadRoute, to, `this route is unusable (${deadReason})`);
          deadSt.retries = 1;
          deadSt.lastFailAt = Date.now();
          stats.takeovers += 1;
          deadSt.busyLastAt = Date.now();
          deadSt.routeFails = 0;
          deadSt.incidentStartedAt = Date.now();
          deadSt.switches += 1;
          // The new route has not failed once yet: the built-in backoff would
          // only delay a recovery that a stale route cannot make anyway. One
          // short first-step pause keeps a fully-dead catalog from spinning the
          // request loop hot, and `fallbackMaxSwitches` bounds the total.
          const wait = localDelay(cfg, 1);
          const deadSignal = typeof AbortSignal !== "undefined" && AbortSignal.any && signal
            ? AbortSignal.any([signal, lifetime.signal])
            : lifetime.signal;
          const deadWaited = await cancellableDelay(wait, deadSignal);
          if (!deadWaited) {
            log.dbg("dead-route switch wait aborted; leaving terminal");
            return downstream;
          }
          return { kind: "retry" };
        }
      }
      if (!deadSt.noFallbackLogged) {
        deadSt.noFallbackLogged = true;
        log.warn(`no fallback route available for ${routeKey(deadRoute)} (pinned: ${cfg.fallbackRoutes.length}, llm catalog: ${lastCatalogReadable ? "readable" : "missing"}); letting the failure surface`);
      }
      return downstream;
    }
    if (!isDisconnectClass(cfg, { code: failure.code, message: failure.message, status: failure.status, error: failure })) {
      return downstream;
    }

    const id = agent.id ?? "default";
    const st = stateOf(id);
    logWiringOnce();
    // The payload carries the provider but no model. Prefer the route the host
    // actually assembled for the last request (seen on the `agent/request`
    // waterfall), then the session's frozen request header — both are truthful;
    // only then fall back to sniffing the payload.
    const route = routeOf(agent, st, provider, pickModel(payload));
    // provider AND model come from one source. Mixing the payload's provider
    // with `seenRoute`'s model printed impossible pairs on a live Host
    // ("provider=deadroute2 model=dead-model" right after a switch).
    const routeLabel = routeKey(route);
    // Busy-route budget. A count budget (`retries`) is right for a network blip
    // — three strikes and it is a real outage — but wrong for congestion: a
    // throttled/busy route answers again within seconds or minutes, and closing
    // the turn on it is the reported "route busy ⇒ it just drops instead of
    // reconnecting" bug. So a congestion-class failure — a throttle
    // (429/RATE_LIMIT) or any failure whose text carries a retry hint — keeps
    // being retried on top of the count budget, measured as an *idle* budget:
    // the plugin gives up only after the route has gone `busyRouteBudgetMs`
    // without a single reconnect attempt. Measuring from the incident's first
    // failure instead (as 1.3.0 did) kills long congestion anyway — the live
    // log shows a qoder-cn route that stayed busy for 45 minutes while every
    // new failure was refused with "busy for 2700s > 600s". Network blips keep
    // the count budget exactly as before.
    const retryAfter = Number(failure.providerRetryAfterMs);
    const hintText = [failure.message, errorText(failure)].filter(Boolean).join(" | ");
    const hintMs = cfg.honorMessageRetryHint ? messageRetryHintMs(hintText) : undefined;
    const throttled = isRateLimit(cfg, { code: failure.code, message: failure.message, status: failure.status, error: failure });
    const busy = (Number.isFinite(retryAfter) && retryAfter > 0) || Number.isFinite(hintMs) || throttled;
    // Layer C — model fallback (选模型重试). Once this route has spent its own
    // count budget (and failed at least `fallbackAfterFailures` times), retrying
    // it any further is stubbornness rather than patience: move the request to
    // another provider/model and grant it a fresh budget. This runs before the
    // gate below, so the failure that triggers the switch survives and gets
    // retried on the new route instead of dying here.
    st.routeFails += 1;
    // How long this incident has been going on. `lastFailAt` is refreshed on
    // every takeover, so it cannot answer that question.
    if (!st.incidentStartedAt) st.incidentStartedAt = Date.now();
    const incidentMs = Date.now() - st.incidentStartedAt;
    // Time since the last reconnect attempt; 0 = no congestion incident yet.
    const busyIdleMs = st.busyLastAt ? Date.now() - st.busyLastAt : 0;
    let withinCount = st.retries < cfg.retries;
    const withinBusy = busy && busyIdleMs < cfg.busyRouteBudgetMs;
    // 老大 2026-10-29 scenario: stay on THIS model and keep hammering a
    // congested route until it answers — "retry until it runs", no matter how
    // many minutes the queue lasts. Any failure that reached this point has
    // already been screened by deadRouteReason above (auth / expired
    // subscription / invalid key / permanently-out-of-credits stop there and
    // never get here), so it is by definition retryable. With
    // `retryUntilSuccess` the count and idle budgets stop binding: the retry
    // is granted at the same capped-backoff cadence as before, up to
    // `retryUntilSuccessMaxMs`. That ceiling is not a retry budget in disguise:
    // a route that has not served a single request in two hours is broken, and
    // a session that keeps whispering retries forever would hide the failure
    // from the user instead of surfacing it.
    const relentless = cfg.retryUntilSuccess && (!cfg.retryUntilSuccessMaxMs || incidentMs < cfg.retryUntilSuccessMaxMs);
    // Layer C arming. Two honest ways to conclude "this route is not going to
    // work": its count budget is spent (normal mode), or it has been failing
    // for `fallbackAfterMs` (in relentless mode the count budget never runs
    // out, so time is the only signal — without it the panel's fallback switch
    // would silently do nothing).
    const armFallback = cfg.modelFallback.enabled
      && st.switches < cfg.fallbackMaxSwitches
      && st.routeFails >= cfg.fallbackAfterFailures
      && (relentless ? incidentMs >= cfg.fallbackAfterMs : !withinCount);
    if (armFallback) {
      const fromRoute = route;
      const to = await fallbackRouteFor(fromRoute, st);
      if (to) {
        applyRouteSwitch(agent, st, fromRoute, to, `${st.routeFails} consecutive failures over ${Math.round(incidentMs / 1000)}s on this route`);
        st.retries = 0;               // fresh count budget on the new route
        st.busyLastAt = Date.now();
        st.routeFails = 0;
        st.switches += 1;
        // The new route gets its own full window, so a switch does not consume
        // the ceiling that belongs to a route which has already failed.
        st.incidentStartedAt = Date.now();
        withinCount = true;
      } else if (!st.noFallbackLogged) {
        // One line per incident: every later failure would repeat the same fact.
        st.noFallbackLogged = true;
        log.warn(`no fallback route available for ${routeKey(fromRoute)} (pinned: ${cfg.fallbackRoutes.length}, llm catalog: ${lastCatalogReadable ? "readable" : "missing"}); staying on this route`);
      }
    }
    if (!withinCount && !withinBusy && !relentless) {
      const why = cfg.retryUntilSuccess && cfg.retryUntilSuccessMaxMs && incidentMs >= cfg.retryUntilSuccessMaxMs
        ? `until-success window spent (${humanMs(incidentMs)} >= ${humanMs(cfg.retryUntilSuccessMaxMs)}) with no completed request`
        : busy
          ? `route idle for ${humanMs(busyIdleMs)} > ${humanMs(cfg.busyRouteBudgetMs)} of reconnect budget`
          : `${st.retries}/${cfg.retries} count budget spent`;
      stats.refusals += 1;
      log.warn(`layer A budget exhausted for agent ${id} (${routeLabel}, ${why}); letting the failure close the turn`);
      return downstream;
    }
    st.retries += 1;
    stats.takeovers += 1;
    if (busy) st.busyLastAt = Date.now();
    st.lastFailAt = Date.now();
    // Delay precedence: the provider's structured Retry-After, then its own
    // in-message hint (starting at the cadence it asked for, then backing off
    // so a long congestion is not polled hundreds of times), then the class
    // window — rate limits get the long, silent one, every other disconnect
    // class the short network one.
    let delayMs;
    let via = "";
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      delayMs = Math.min(retryAfter, cfg.rateLimitMaxDelayMs);
      via = " via=retry-after";
    } else if (Number.isFinite(hintMs)) {
      delayMs = hintDelay(cfg, hintMs, st.retries - 1);
      via = " via=message-hint";
    } else if (throttled) {
      delayMs = localDelay(cfg, st.retries, { initialDelayMs: cfg.rateLimitInitialDelayMs, maxDelayMs: cfg.rateLimitMaxDelayMs });
    } else {
      delayMs = localDelay(cfg, st.retries);
    }
    let budget;
    if (withinCount) budget = `${st.retries}/${cfg.retries}`;
    else if (relentless) budget = `until-success #${st.retries}${busy ? ` (idle ${humanMs(busyIdleMs)})` : ""}`;
    else budget = `idle ${humanMs(busyIdleMs)}/${humanMs(cfg.busyRouteBudgetMs)}`;
    // humanMs, not a bare /1000: a sub-second backoff would otherwise print
    // "in 0s" and read as "retrying instantly" while it really waits 400ms.
    log.warn(`taking over a disconnect-class failure from the built-in retry: ${describe(cfg, failure)} — retry ${budget} in ${humanMs(delayMs)}${via} (route ${routeLabel} agent=${id})`);

    const fused = typeof AbortSignal !== "undefined" && AbortSignal.any && signal
      ? AbortSignal.any([signal, lifetime.signal])
      : lifetime.signal;
    const waited = await cancellableDelay(delayMs, fused);
    if (!waited) {
      log.dbg("layer A wait aborted; leaving terminal");
      return downstream;
    }
    return { kind: "retry" };
  });

  // ---------------------------------------------------------------- Layer B
  function scheduleRerun(agent, errorLabel, errorInfo) {
    const st = stateOf(agent.id);
    if (st.rerunTimer) return; // one rerun already pending
    if (st.reruns >= cfg.reruns) {
      log.warn(`layer B cap reached for agent ${agent.id} (${cfg.reruns} consecutive reruns) — giving up; last error: ${errorLabel}`);
      return;
    }
    const n = st.reruns + 1;
    log.warn(`scheduling auto-rerun ${n}/${cfg.reruns} for agent ${agent.id} in ${humanMs(cfg.rerunDelayMs)} — ${errorLabel}`);
    st.rerunTimer = setTimeout(async () => {
      st.rerunTimer = null;
      try {
        if (lifetime.signal.aborted) return;
        if (agent.status === "running") {
          log.dbg(`rerun skipped: agent ${agent.id} is already running`);
          return;
        }
        const text = rerunPrompt(cfg, n, errorInfo.shortLabel ?? errorLabel);
        // Count the attempt before injecting: if the injection itself fails,
        // the cap still holds and this cannot turn into a rerun loop.
        st.reruns = n;
        // The one and only message-injection path: admitFollowup builds a
        // complete UserMessage and REFUSES to persist anything the cold-restore
        // validator would reject, so a failed rerun costs a rerun, not a session.
        await admitFollowup(agent, {
          content: [{ type: "text", text }],
          source: { kind: "auto-rerun", form: "notice", summary: `auto-rerun attempt ${n}` },
        });
        stats.reruns += 1;
        log.info(`auto-rerun ${n}/${cfg.reruns} submitted for agent ${agent.id}`);
      } catch (error) {
        log.warn(`auto-rerun followup failed for agent ${agent.id}: ${error?.message ?? error}`);
      }
    }, cfg.rerunDelayMs);
    st.rerunTimer.unref?.();
  }

  const disposeAgentError = ctx.on("agent/error", (payload) => {
    if (!cfg.rerun.enabled) return;
    const { agent, error } = payload ?? {};
    if (cfg.debug) {
      log.dbg(`agent/error payload keys: ${Object.keys(payload ?? {}).join(",")}; error=${errorText(error)?.slice(0, 300)}`);
    }
    if (!agent?.id) return;
    if (!isDisconnectClass(cfg, { code: error?.code, status: error?.status, message: errorText(error), error })) {
      log.dbg(`terminal error is not disconnect-class, no rerun: ${describe(cfg, { error })}`);
      return;
    }
    const silent = rerunBlockedCode(cfg, { code: error?.code, status: error?.status, error });
    if (silent) {
      // Visible reruns are reserved for real disconnects; throttling recovers
      // through the silent Layer A retry and must not nudge the user.
      log.dbg(`terminal ${silent} error: silent retry only, no visible rerun`);
      return;
    }
    scheduleRerun(agent, describe(cfg, { error }), {
      shortLabel: error?.code ? String(error.code) : "network",
    });
  });

  // ------------------------------------------------------------- reset rules
  const disposeDisposed = ctx.on("agent/disposed", (payload) => {
    const agent = payload?.agent ?? payload;
    if (agent?.id) dropAgent(agent.id);
  });

  const disposeInbox = ctx.on("agent/inbox/inserted", (payload) => {
    // A real user message supersedes any pending auto-rerun.
    const agent = payload?.agent;
    const kind = payload?.message?.source?.kind;
    if (agent?.id && kind === "user") resetAgent(agent.id, "user input");
  });

  // The reverse lookup a session-scoped event needs: the Agent whose session
  // committed it. `agent.id` is what every piece of plugin state is keyed by,
  // while `session/event` only names the Session.
  function agentForSession(sid) {
    if (!sid) return undefined;
    try {
      for (const agent of ctx.agents?.list?.() ?? []) {
        const session = agent?.session;
        if (session?.id === sid || session?.header?.id === sid) return agent;
      }
      const direct = ctx.agents?.get?.(sid);
      if (direct?.session) return direct;
    } catch (error) {
      log.dbg(`agents lookup for session ${sid} failed: ${errorText(error)}`);
    }
    return undefined;
  }

  const disposeSessionEvent = ctx.on("session/event", (session, event) => {
    // The host declares this hook as 'session/event'(session: Session, event:
    // SessionEvent) — TWO positional arguments. Reading it as a single
    // `{ session, event }` payload (as this listener once did) silently matches
    // nothing, so the turn-completion reset never fired on a live Host. Accept
    // both shapes: the positional form the Host really uses, and the wrapped
    // object the fake harness hands in.
    if (event === undefined && session && typeof session === "object" && session.event) {
      event = session.event;
      session = session.session;
    }
    const type = event?.type;
    // Cheap type gate before the Agent lookup: this hook fires for EVERY durable
    // session event (steps, tool calls, messages), and only two of them matter.
    if (type !== "assistant/message" && type !== "turn/end") return;
    const sid = session?.id ?? session?.header?.id;
    if (!sid) return;
    const agent = agentForSession(sid);
    if (!agent) return;
    if (type === "assistant/message") {
      // The route demonstrably answered: stamp the proof that a later quiet
      // stretch means recovery rather than a long backoff (see servedAt). An
      // `interrupted: true` anchor is a CANCELLED stream carrying whatever
      // prefix had arrived — the host appends one of those too, and it is not
      // evidence the route finished a response.
      if (event?.data?.interrupted === true) return;
      const st = agents.get(agent.id ?? "default");
      if (!st) return;
      st.servedAt = Date.now();
      // `retryUntilSuccessMaxMs` is defined as "this long WITHOUT a completed
      // request", so a completed request has to zero that clock immediately.
      // Leaving it to the incident-gap rule would keep counting a route that is
      // visibly answering, and the ceiling could then fire on a healthy route
      // that merely flaps faster than `incidentGapMs`. A delivered answer also
      // breaks the "consecutive failures" streak that Layer C counts.
      st.incidentStartedAt = 0;
      st.routeFails = 0;
      // The count budget and the congestion clock belong to the incident, not
      // to the turn: leaving them set made the NEXT incident start with its
      // budget already spent and its first backoff already multiplied.
      st.retries = 0;
      st.busyLastAt = 0;
      return;
    }
    // A turn that ran to its end closes the incident → reset consecutive
    // counters. The Host carries the reason under `event.data.reason` (the type
    // is `'turn/end': { turn, reason: TurnEndReason }`), with `event.reason`
    // accepted as the flatter shape. `max-tokens` counts as an ending too: the
    // reply was cut off by a token budget, not by a broken route, and treating
    // it as a failure would throw away a genuine recovery.
    const kind = event?.data?.reason?.kind ?? event?.reason?.kind;
    if (kind !== "completed" && kind !== "max-tokens") return;
    resetAgent(agent.id ?? "default", `turn ended (${kind})`);
  });

  ctx.effect(() => async () => {
    // One listener failing to detach must not skip the rest of the cleanup:
    // the timers below are what keep a hot-reload from leaking work.
    for (const dispose of [disposeRequestRoute, disposeRequestError, disposeAgentError, disposeDisposed, disposeInbox, disposeSessionEvent]) {
      try { dispose?.(); } catch (error) { log.dbg(`listener dispose failed: ${errorText(error)}`); }
    }
    lifetime.abort(new Error("auto-rerun plugin disposed"));
    for (const [id] of agents) dropAgent(id);
    log.info("disposed: all listeners and timers cleared");
  }, "auto-rerun: dispose listeners and timers");
}

export { apply, inject, name };
