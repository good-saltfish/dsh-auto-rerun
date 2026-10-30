// Smoke test for dsh-auto-rerun — fake ctx harness.
// Verifies: pass-through of non-disconnect codes, Layer A takeover on
// disconnect-class terminal, budget cap, Layer B scheduling + cap.
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN = process.argv[2];
if (!PLUGIN) { console.error("usage: node smoke.mjs <abs path to index.js>"); process.exit(2); }
const mod = await import(pathToFileURL(PLUGIN).href);

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

function makeCtx(cfg, services = {}) {
  const handlers = {};
  const logs = [];
  const ctx = {
    logger: { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`) },
    on: (event, fn, opts) => {
      const list = (handlers[event] ??= []);
      if (opts?.prepend) list.unshift(fn); else list.push(fn);
      return () => { const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); };
    },
    effect: () => {},
    agents: { list: () => services.agentsList ?? [] },
    get: (key) => services[key],
    // Present only when a case supplies one: the plugin registers its panel
    // routes inside `ctx.inject([...], cb)`, so the fake must be in place
    // BEFORE apply runs or the routes never exist.
    inject: services.inject,
    _handlers: handlers,
    _logs: logs,
    async fireRequestError(payload, downstreamDecision) {
      const [fn] = handlers["agent/request-error"] ?? [];
      const next = async () => downstreamDecision;
      return fn ? fn(payload, next) : next();
    },
    async fireAgentError(payload) {
      for (const fn of handlers["agent/error"] ?? []) await fn(payload);
    },
    // The Host declares session/event as (session, event) — two positional
    // arguments — so the harness fires it that way too. A listener written
    // against a single wrapped payload silently never matches on a live Host,
    // which is exactly the bug case 44 guards.
    async fireSessionEvent(session, event) {
      for (const fn of handlers["session/event"] ?? []) await fn(session, event);
    },
    // Waterfall: listeners run in registration order (prepend first), each may
    // call next(); the last one's fallback is the config the machine supplied.
    async fireRequest(payload, baseConfig) {
      const chain = handlers["agent/request"] ?? [];
      let i = 0;
      const next = async () => (i < chain.length ? chain[i++](payload, next) : baseConfig);
      return next();
    },
  };
  mod.apply(ctx, cfg);
  return ctx;
}

const FAST = {
  initialDelayMs: 20, maxDelayMs: 40, jitterRatio: 0,
  rateLimitInitialDelayMs: 30, rateLimitMaxDelayMs: 60,
  retries: 2, reruns: 2, rerunDelayMs: 10, debug: false,
  // 1.6.0 changed two DEFAULTS: retryUntilSuccess flipped to `true` (no budget
  // cap unless a dead-route signal) and modelFallback flipped to `enabled: false`.
  // The pre-1.6 budget/Layer-C cases below were written against the OLD defaults,
  // so the shared FAST harness pins them back to the count/idle-budget +
  // switch-on behaviour those cases assert. The new defaults get their own
  // dedicated cases (36–39) which override these two keys explicitly.
  retryUntilSuccess: false,
  modelFallback: { enabled: true },
  // 1.8.0 gave `settingsFile` a portable default under ${DSH_HOME:-~/.dsh}. A
  // test must never write into the developer's real DSH home, so the shared
  // harness opts out explicitly ("" = keep the panel toggles in memory).
  settingsFile: "",
};

console.log("== 1. non-disconnect terminal passes through ==");
{
  const ctx = makeCtx(FAST);
  const r = await ctx.fireRequestError(
    { agent: { id: "a1" }, provider: "p", model: "m", failure: { code: "AUTH", message: "invalid api key" }, retryPolicy: undefined },
    undefined,
  );
  ok(r?.kind !== "retry", "AUTH error is left terminal (no takeover)");
}

console.log("== 2. disconnect-class terminal is taken over ==");
{
  const ctx = makeCtx(FAST);
  const r = await ctx.fireRequestError(
    { agent: { id: "a2" }, provider: "p", model: "m", failure: { code: "TRANSPORT", message: "socket hang up" } },
    undefined,
  );
  ok(r?.kind === "retry", "TRANSPORT error returns {kind:'retry'} after wait");
}

console.log("== 3. errno + status heuristics classify ==");
{
  const ctx = makeCtx(FAST);
  const r1 = await ctx.fireRequestError(
    { agent: { id: "a3" }, provider: "p", model: "m", failure: { code: "ECONNRESET" } }, undefined);
  ok(r1?.kind === "retry", "ECONNRESET classified disconnect");
  const r2 = await ctx.fireRequestError(
    { agent: { id: "a4" }, provider: "p", model: "m", failure: { code: "HTTP", status: 503, message: "Service Unavailable" } }, undefined);
  ok(r2?.kind === "retry", "status 503 classified disconnect");
}

console.log("== 4. Layer A budget cap ==");
{
  const ctx = makeCtx(FAST);
  const agent = { id: "a5" };
  const payload = { agent, provider: "p", model: "m", failure: { code: "TIMEOUT" } };
  const r1 = await ctx.fireRequestError(payload, undefined);
  const r2 = await ctx.fireRequestError(payload, undefined);
  const r3 = await ctx.fireRequestError(payload, undefined); // retries=2 → 3rd must be terminal
  ok(r1?.kind === "retry" && r2?.kind === "retry" && r3?.kind !== "retry", "budget caps at retries=2 then declines");
}

console.log("== 5. downstream retry decision is honored, no double ==");
{
  const ctx = makeCtx(FAST);
  const r = await ctx.fireRequestError(
    { agent: { id: "a6" }, provider: "p", model: "m", failure: { code: "TRANSPORT" } },
    { kind: "retry" },
  );
  ok(r?.kind === "retry", "existing downstream retry passes through untouched");
}

console.log("== 6. always mode is transparent ==");
{
  const ctx = makeCtx(FAST);
  let nextCalled = 0;
  const [fn] = ctx._handlers["agent/request-error"];
  const r = await fn(
    { agent: { id: "a7" }, provider: "p", model: "m", failure: { code: "TRANSPORT" }, retryPolicy: { mode: "always" } },
    async () => { nextCalled++; return undefined; },
  );
  ok(nextCalled === 1 && r === undefined, "always-mode policy → pure delegation");
}

console.log("== 7. Layer B schedules a followup and respects cap ==");
{
  const ctx = makeCtx(FAST);
  const followups = [];
  const agent = { id: "a8", status: "idle", followup: (m) => followups.push(m) };
  await ctx.fireAgentError({ agent, error: { code: "TRANSPORT", message: "fetch failed" } });
  await delay(40);
  ok(followups.length === 1, "disconnect terminal schedules one auto-rerun followup");
  ok(followups[0]?.source?.kind === "auto-rerun", "followup source marked auto-rerun");
  ok(typeof followups[0]?.content?.[0]?.text === "string" && followups[0].content[0].text.includes("继续"), "followup asks to resume work");
  await ctx.fireAgentError({ agent, error: { code: "TIMEOUT" } });
  await delay(40);
  ok(followups.length === 2, "second incident schedules second rerun");
  await ctx.fireAgentError({ agent, error: { code: "TIMEOUT" } });
  await delay(40);
  ok(followups.length === 2, "cap reruns=2 blocks the third rerun");
}

console.log("== 8. Layer B ignores non-disconnect terminal ==");
{
  const ctx = makeCtx(FAST);
  const followups = [];
  const agent = { id: "a9", status: "idle", followup: (m) => followups.push(m) };
  await ctx.fireAgentError({ agent, error: { code: "AUTH", message: "quota exceeded: insufficient balance" } });
  await delay(40);
  ok(followups.length === 0, "quota/auth error does NOT trigger rerun");
}

console.log("== 10. RATE_LIMIT is silent: Layer A retries, Layer B never nudges ==");
{
  const ctx = makeCtx(FAST);
  const followups = [];
  const agent = { id: "a10", status: "idle", followup: (m) => followups.push(m) };
  const r = await ctx.fireRequestError(
    { agent, provider: "p", model: "m", failure: { code: "RATE_LIMIT", status: 429, message: "too many requests" } },
    undefined,
  );
  ok(r?.kind === "retry", "RATE_LIMIT still gets the silent Layer A takeover");
  await ctx.fireAgentError({ agent, error: { code: "RATE_LIMIT", status: 429, message: "too many requests" } });
  await delay(40);
  ok(followups.length === 0, "RATE_LIMIT code does NOT trigger a visible rerun");
  await ctx.fireAgentError({ agent, error: { code: "HTTP", status: 429, message: "rate limited" } });
  await delay(40);
  ok(followups.length === 0, "status 429 alone also stays silent");
  await ctx.fireAgentError({ agent, error: { code: "TRANSPORT", message: "socket hang up" } });
  await delay(40);
  ok(followups.length === 1, "a genuine disconnect after throttling still reruns once");
}

console.log("== 11. default rerun cap is 1 ==");
{
  // settingsFile must stay pinned OFF like FAST: without it this case reads the
  // developer's real ~/.dsh/auto-rerun-settings.json (written by the live panel)
  // and its saved rerunDelayMs overrides the test's 10ms — a test-isolation
  // leak, not plugin behaviour. `reruns` stays unset so the DEFAULT cap (1) is
  // what the assertions actually check.
  const ctx = makeCtx({ initialDelayMs: 20, maxDelayMs: 40, jitterRatio: 0, retries: 2, rerunDelayMs: 10, settingsFile: "" });
  const followups = [];
  const agent = { id: "a11", status: "idle", followup: (m) => followups.push(m) };
  await ctx.fireAgentError({ agent, error: { code: "TRANSPORT" } });
  await delay(40);
  await ctx.fireAgentError({ agent, error: { code: "TIMEOUT" } });
  await delay(40);
  ok(followups.length === 1, "default config caps at one consecutive rerun");
}

console.log("== 12. rerunExcludeCodes: [] lets throttling nudge again ==");
{
  const ctx = makeCtx({ ...FAST, rerunExcludeCodes: [] });
  const followups = [];
  const agent = { id: "a12", status: "idle", followup: (m) => followups.push(m) };
  await ctx.fireAgentError({ agent, error: { code: "RATE_LIMIT", message: "too many requests" } });
  await delay(40);
  ok(followups.length === 1, "empty exclude list restores the visible rerun");
}

console.log("== 9. disabled plugin registers nothing ==");
{
  const ctx = makeCtx({ ...FAST, enabled: false });
  ok(Object.keys(ctx._handlers).length === 0, "enabled:false mounts no listeners");
}

console.log("== 13. rate limits get the long silent window, not the network one ==");
{
  const cfg = { initialDelayMs: 20, maxDelayMs: 40, jitterRatio: 0, rateLimitInitialDelayMs: 160, rateLimitMaxDelayMs: 160, retries: 1 };

  let t0 = Date.now();
  await makeCtx(cfg).fireRequestError(
    { agent: { id: "a13a" }, provider: "p", model: "m", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } },
    undefined,
  );
  const throttleMs = Date.now() - t0;

  t0 = Date.now();
  await makeCtx(cfg).fireRequestError(
    { agent: { id: "a13b" }, provider: "p", model: "m", failure: { code: "TRANSPORT", message: "socket hang up" } },
    undefined,
  );
  const transportMs = Date.now() - t0;

  t0 = Date.now();
  await makeCtx(cfg).fireRequestError(
    { agent: { id: "a13c" }, provider: "p", model: "m", failure: { code: "SERVER", status: 503, message: "bad gateway", providerRetryAfterMs: 150 } },
    undefined,
  );
  const retryAfterMs = Date.now() - t0;

  ok(throttleMs >= 140, `RATE_LIMIT waits the long window (${throttleMs}ms >= 140ms)`);
  ok(transportMs < 140, `transport keeps the short window (${transportMs}ms < 140ms)`);
  ok(retryAfterMs >= 130 && retryAfterMs < 400, `provider Retry-After is honored (${retryAfterMs}ms ~ 150ms)`);
}

console.log("== 14. in-message retry hints are parsed ==");
{
  const parse = mod.__messageRetryHintMs;
  const cases = [
    ["Qoder is busy — the request was queued (retry in ~3s)", 3000],
    ["Rate limit reached. Please try again in 2.5s", 2500],
    ["try again in 400ms", 400],
    ["retry_after: 5", 5000],
    ["retry-after=2", 2000],
    ["服务繁忙，请 3 秒后重试", 3000],
    ["稍等 2 分钟后再试", 120000],
    ["tpm exhausted", undefined],
    ["rate limit reached for RPM (request_id: chatcmpl-abc)", undefined],
    ["", undefined],
    [undefined, undefined],
  ];
  for (const [text, want] of cases) {
    const got = parse(text);
    ok(got === want, `hint(${JSON.stringify(String(text)).slice(0, 46)}) -> ${got}ms (want ${want})`);
  }
}

console.log("== 15. a hint beats the rate-limit window (live delay path) ==");
{
  const hinted = "Qoder is busy — the request was queued (retry in 150ms)";
  const longCfg = { ...FAST, retries: 1, rateLimitInitialDelayMs: 700, rateLimitMaxDelayMs: 700, messageHintMinMs: 0, messageHintMaxMs: 5000 };

  let t0 = Date.now();
  const hintedCtx = makeCtx(longCfg);
  await hintedCtx.fireRequestError(
    { agent: { id: "a15a" }, provider: "qoder", model: "q", failure: { code: "RATE_LIMIT", status: 503, message: hinted, type: "rate_limit" } },
    undefined,
  );
  const hintedMs = Date.now() - t0;
  ok(hintedMs >= 130 && hintedMs < 600, `hint shortens the wait to ~150ms, not 700ms (${hintedMs}ms)`);
  ok(hintedCtx._logs.some((l) => l.includes("via=message-hint")), "log records via=message-hint");

  t0 = Date.now();
  await makeCtx({ ...longCfg, honorMessageRetryHint: false }).fireRequestError(
    { agent: { id: "a15b" }, provider: "qoder", model: "q", failure: { code: "RATE_LIMIT", status: 503, message: hinted, type: "rate_limit" } },
    undefined,
  );
  const offMs = Date.now() - t0;
  ok(offMs >= 660, `honorMessageRetryHint:false restores the class window (${offMs}ms >= 660ms)`);

  t0 = Date.now();
  await makeCtx(longCfg).fireRequestError(
    { agent: { id: "a15c" }, provider: "sensenova", model: "s", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted", type: "quota_exceeded_error" } },
    undefined,
  );
  const noHintMs = Date.now() - t0;
  ok(noHintMs >= 660, `a hint-less quota error keeps the long window (${noHintMs}ms >= 660ms)`);
}

console.log("== 16. model label falls back through the payload shapes ==");
{
  const pick = mod.__pickModel;
  ok(pick({ model: "m1" }) === "m1", "top-level model wins");
  ok(pick({ request: { model: "m2" } }) === "m2", "request.model is used");
  ok(pick({ agent: { model: "m3" } }) === "m3", "agent.model is used");
  ok(pick({ model: "  " }) === "unknown", "blank model falls through to unknown");
  ok(pick(undefined) === "unknown", "missing payload yields unknown");
}

console.log("== 17. hint window clamps + mount line stamps the real version ==");
{
  const cfg = mod.__mergeConfig({ jitterRatio: 0 });
  ok(cfg.honorMessageRetryHint === true, "message hints default to on");
  ok(cfg.messageHintMinMs === 1000 && cfg.messageHintMaxMs === 60000, "hint window defaults are 1s/60s");
  ok(mod.__hintDelay(cfg, 200) === 1000, "too-short hint is lifted to the 1s floor");
  ok(mod.__hintDelay(cfg, 120000) === 60000, "over-long hint is cut to the 60s ceiling");
  ok(mod.__hintDelay(cfg, 3000) === 3000, "in-window hint is used as-is");

  const ctx = makeCtx({ ...FAST });
  const mount = ctx._logs[0] ?? "";
  ok(/mounted v\d+\.\d+\.\d+ /.test(mount), `mount line carries the real version (${mount.slice(0, 46)}…)`);
  ok(mount.includes("message hints: true"), "mount line reports the hint switch");
}

console.log("== 18. a busy route keeps reconnecting instead of dropping the turn ==");
{
  // The reported bug: "route too busy ⇒ it just disconnects instead of
  // reconnecting". Live log: qiniu 429 x3 (26s/62s/103s) then
  // "layer A budget exhausted ... letting the failure close the turn".
  const cfg = {
    ...FAST, retries: 2, jitterRatio: 0, busyRouteBudgetMs: 400,
    rateLimitInitialDelayMs: 20, rateLimitMaxDelayMs: 40,
    messageHintMinMs: 0, messageHintMaxMs: 5000,
  };
  const ctx = makeCtx(cfg);
  const busyPayload = {
    agent: { id: "a18" }, provider: "qiniu", model: "q",
    failure: { code: "RATE_LIMIT", status: 429, message: "Too many requests for this free model (request_id: chatcmpl-abc)" },
  };
  const kinds = [];
  for (let i = 0; i < 6; i++) kinds.push((await ctx.fireRequestError(busyPayload, undefined))?.kind ?? "terminal");
  ok(kinds.every((k) => k === "retry"), `6 throttled attempts all reconnect despite retries=2 (${kinds.join(",")})`);
  const busyLog = ctx._logs.join("\n");
  ok(busyLog.includes("idle "), "log reports the reconnect-idle budget while reconnecting");

  await delay(450);
  const afterBudget = (await ctx.fireRequestError(busyPayload, undefined))?.kind ?? "terminal";
  ok(afterBudget === "terminal", "past busyRouteBudgetMs of no reconnect attempts the incident really does end");
  ok(ctx._logs.at(-1).includes("budget exhausted") && ctx._logs.at(-1).includes("route idle for"),
    "exhaustion names the idle budget, not a strike count");
}

console.log("== 19. hinted congestion honours the cadence, then backs off ==");
{
  const cfg = {
    ...FAST, retries: 1, jitterRatio: 0, busyRouteBudgetMs: 60000,
    rateLimitInitialDelayMs: 20, rateLimitMaxDelayMs: 5000,
    messageHintMinMs: 0, messageHintMaxMs: 5000, backoffFactor: 2,
  };
  const ctx = makeCtx(cfg);
  const payload = {
    agent: { id: "a19" }, provider: "qoder", model: "q",
    failure: { code: "RATE_LIMIT", status: 503, message: "Qoder is busy — the request was queued (retry in 200ms)" },
  };
  const waits = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await ctx.fireRequestError(payload, undefined);
    waits.push(Date.now() - t);
  }
  ok(waits[0] >= 190 && waits[0] < 320, `first probe uses the provider cadence (${waits[0]}ms)`);
  ok(waits[1] > waits[0] * 1.3 && waits[2] > waits[1] * 1.3, `later probes back off (${waits.join(", ")}ms)`);
  ok(ctx._logs.join("\n").includes("via=message-hint"), "hint path is logged");
}

console.log("== 20. a plain network blip still uses the count budget ==");
{
  const ctx = makeCtx({ ...FAST, retries: 2, busyRouteBudgetMs: 60000 });
  const payload = { agent: { id: "a20" }, provider: "p", model: "m", failure: { code: "TRANSPORT", message: "socket hang up" } };
  const kinds = [];
  for (let i = 0; i < 3; i++) kinds.push((await ctx.fireRequestError(payload, undefined))?.kind ?? "terminal");
  ok(kinds.join(",") === "retry,retry,terminal", `unthrottled blip still stops after retries=2 (${kinds.join(",")})`);
  ok(ctx._logs.at(-1).includes("count budget spent"), "exhaustion names the count budget");
}

console.log("== 21. a dying route is switched durably through sessionController ==");
{
  // 选模型重试: after fallbackAfterFailures consecutive failures the request
  // should move to another provider/model instead of grinding the same route.
  const calls = [];
  const sessionController = { agents: { selectForNextRequest: (agent, selection) => calls.push({ agent, selection }) } };
  const cfg = {
    ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0,
    fallbackRoutes: ["backup/model-b"], fallbackAfterFailures: 1, fallbackMaxSwitches: 1,
  };
  const ctx = makeCtx(cfg, { sessionController });
  const agent = { id: "a21" };
  const payload = { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } };
  const first = await ctx.fireRequestError(payload, undefined);
  ok(first?.kind === "retry" && calls.length === 0, "the first failure is retried on the same route");
  const r = await ctx.fireRequestError(payload, undefined);
  ok(r?.kind === "retry", "the failure that spends the route budget still survives the switch");
  ok(calls.length === 1 && calls[0].selection.provider === "backup" && calls[0].selection.model === "model-b",
    `a model/selection switch is recorded (${JSON.stringify(calls[0]?.selection)})`);
  ok(calls[0]?.agent === agent, "the switch is recorded for this agent");
  ok(ctx._logs.join("\n").includes("model fallback: qiniu/q → backup/model-b"), "the switch is logged with both routes");
  ok(ctx._logs.join("\n").includes("the session continues on backup/model-b"), "log states the durable outcome");

  // Durable means the host owns the route now: this plugin must not rewrite
  // requests any more, or the transcript notice would be a lie, and a user who
  // moves the route back would be silently overruled.
  const asked = await ctx.fireRequest({ agent }, { provider: "backup", model: "model-b" });
  ok(asked.provider === "backup" && asked.model === "model-b", "a request already on the wanted route is left alone");
  const back = await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  ok(back.provider === "qiniu" && back.model === "q", "no silent rewrite once the host owns the selection");
}

console.log("== 22. without a session controller the override carries one request ==");
{
  const cfg = {
    ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0,
    fallbackRoutes: ["backup/model-b"], fallbackAfterFailures: 1, fallbackMaxSwitches: 1, debug: true,
  };
  const ctx = makeCtx(cfg);           // no ctx.get services at all
  const agent = { id: "a22" };
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  }
  ok(ctx._logs.join("\n").includes("applied to the next request only"), "fallback path is logged as transient");

  const rewritten = await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q", reasoningEffort: "high", maxTokens: 4096 });
  ok(rewritten.provider === "backup" && rewritten.model === "model-b", "the retried request is moved to the backup route");
  ok(rewritten.reasoningEffort === undefined, "inherited reasoning effort is dropped for the new model");
  ok(rewritten.maxTokens === 4096, "the rest of the call config survives");

  const kept = await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  ok(kept.provider === "backup", "the fallback stays in force for the rest of the incident");
  const foreign = await ctx.fireRequest({ agent }, { provider: "third", model: "x" });
  ok(foreign.provider === "third" && foreign.model === "x", "a route moved by someone else drops the override");
  ok(ctx._logs.join("\n").includes("fallback override dropped"), "the dropped override is explained in the log");
}

console.log("== 23. the live catalog supplies candidates when none are pinned ==");
{
  const resolved = [];
  const llm = {
    listProviders: async () => [{ id: "qiniu" }, { id: "backup" }],
    listModels: async (id) => (id === "qiniu" ? [{ id: "q" }] : [{ id: "model-b" }]),
    resolveModelInfo: async (provider, model) => { resolved.push(`${provider}/${model}`); return {}; },
  };
  const calls = [];
  const sessionController = { agents: { selectForNextRequest: (_a, s) => calls.push(s) } };
  const cfg = { ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0, fallbackAfterFailures: 1, fallbackMaxSwitches: 1 };
  const ctx = makeCtx(cfg, { llm, sessionController });
  const agent = { id: "a23" };
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "rate limit reached for RPM" } }, undefined);
  }
  ok(calls.length === 1 && calls[0].provider === "backup" && calls[0].model === "model-b",
    `catalog fallback picks another provider (${JSON.stringify(calls[0])})`);
  ok(resolved.includes("backup/model-b"), "the candidate is validated through resolveModelInfo");
}

console.log("== 24. fallback obeys its switch budget and its off switch ==");
{
  const base = { ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0, fallbackAfterFailures: 1, fallbackMaxSwitches: 1 };
  const off = makeCtx({ ...base, modelFallback: { enabled: false } }, { sessionController: { agents: { selectForNextRequest: () => { throw new Error("must not be called"); } } } });
  await off.fireRequestError({ agent: { id: "a24a" }, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  ok(!/model fallback: \S+ →/.test(off._logs.join("\n")), "modelFallback.enabled=false never switches");

  const capped = makeCtx({ ...base, fallbackRoutes: ["b1/m1", "b2/m2"] }, { sessionController: { agents: { selectForNextRequest: () => {} } } });
  const payload = { agent: { id: "a24b" }, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } };
  for (let i = 0; i < 4; i++) await capped.fireRequestError(payload, undefined);
  const switches = (capped._logs.join("\n").match(/model fallback: \S+ →/g) ?? []).length;
  ok(switches === 1, `fallbackMaxSwitches=1 allows exactly one switch (saw ${switches})`);
}

console.log("== 25. route strings parse and key the same way ==");
{
  ok(JSON.stringify(mod.__parseRoute("qiniu/q")) === JSON.stringify({ provider: "qiniu", model: "q" }), "simple route parses");
  ok(mod.__parseRoute("openrouter/vendor/model-1").model === "vendor/model-1", "the model keeps its own slashes");
  ok(mod.__parseRoute("no-slash") === undefined && mod.__parseRoute("/x") === undefined && mod.__parseRoute("x/") === undefined,
    "malformed routes are rejected");
}

console.log("== 26. the same model on another provider wins the catalog ==");
{
  // Quota is per provider, so moving "q" to another provider keeps behaviour
  // identical while escaping the throttled bucket — that must beat an
  // arbitrary different model.
  const llm = {
    listProviders: async () => [{ id: "qiniu" }, { id: "backup" }, { id: "other" }],
    listModels: async (id) => (id === "qiniu" ? [{ id: "q" }] : id === "backup" ? [{ id: "q" }] : [{ id: "something-else" }]),
  };
  const calls = [];
  const cfg = { ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0, fallbackAfterFailures: 1, fallbackMaxSwitches: 1 };
  const ctx = makeCtx(cfg, { llm, sessionController: { agents: { selectForNextRequest: (_a, s) => calls.push(s) } } });
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent: { id: "a26" }, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  }
  ok(calls.length === 1 && calls[0].provider === "backup" && calls[0].model === "q",
    `same model id on another provider is preferred (${JSON.stringify(calls[0])})`);
}

console.log("== 27. the log names the real route, not \"unknown\" ==");
{
  // The payload has no model field; the session header does. An honest label
  // matters because it is also the `from` side of a fallback switch.
  const ctx = makeCtx({ ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0 });
  const agent = { id: "a27", session: { requestHeader: () => ({ config: { provider: "qiniu", model: "conatus-free" } }) } };
  await ctx.fireRequestError(
    { agent, provider: "qiniu", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  const line = ctx._logs.find((l) => l.includes("taking over")) ?? "";
  ok(line.includes("route qiniu/conatus-free"), `takeover log uses the session header route (${line.slice(0, 60)}…)`);
  ok(!line.includes("unknown"), "no more unknown route in the label");
}

console.log("== 28. the per-agent guard outranks a later host listener ==");
{
  // The host installs its own agent/request listener when it creates the agent,
  // i.e. *after* this plugin mounted. cordis runs prepended listeners
  // newest-first, so only a guard registered on the agent's own context at
  // switch time sits outside it — otherwise the host re-applies its route and
  // the switch is silently undone.
  const cfg = {
    ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0,
    fallbackRoutes: ["backup/model-b"], fallbackAfterFailures: 1, fallbackMaxSwitches: 1, debug: true,
  };
  const ctx = makeCtx(cfg);
  const agentCtx = {
    on: (event, fn, opts) => {
      if (opts?.prepend) ctx._handlers[event].unshift(fn);
      else ctx._handlers[event].push(fn);
      return () => {
        const at = ctx._handlers[event].indexOf(fn);
        if (at >= 0) ctx._handlers[event].splice(at, 1);
      };
    },
  };
  const agent = { id: "a28", ctx: agentCtx };
  // The host's model-selection listener: always claims its own frozen route.
  ctx.on("agent/request", async (payload, next) => {
    const config = await next();
    return { ...config, provider: "qiniu", model: "q" };
  }, { prepend: true });
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  }
  const forced = await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  ok(forced.provider === "backup" && forced.model === "model-b",
    `the switch survives the host's own listener (${forced.provider}/${forced.model})`);
}

console.log("== 29. no catalogue and nothing pinned: routes seen in this process are the candidates ==");
{
  // This Host exposes neither ctx.get("llm") nor a pinned list, so the only
  // known-good routes are the ones the Host itself assembled recently — here,
  // another agent's successful route.
  const cfg = {
    ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0, debug: true,
    fallbackAfterFailures: 1, fallbackMaxSwitches: 1,
  };
  const ctx = makeCtx(cfg);
  const other = { id: "a29-other" };
  await ctx.fireRequest({ agent: other }, { provider: "qoder-cn", model: "DeepSeek-Flash" });
  const agent = { id: "a29" };
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  }
  const line = ctx._logs.find((l) => /model fallback: \S+ →/.test(l)) ?? "";
  ok(line.includes("qoder-cn/DeepSeek-Flash"), `the recently seen route becomes the fallback (${line.slice(0, 70)}…)`);
  const forced = await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  ok(forced.provider === "qoder-cn" && forced.model === "DeepSeek-Flash", "the retried request runs on it");
}

console.log("== 30. candidate order: pinned → same model elsewhere → routes seen here → catalogue ==");
{
  const llm = {
    listProviders: async () => [{ id: "qiniu" }, { id: "alpha" }, { id: "beta" }],
    listModels: async (provider) => ({ qiniu: [{ id: "q" }], alpha: [{ id: "x" }], beta: [{ id: "q" }, { id: "y" }] })[provider] ?? [],
    resolveModelInfo: async () => ({ id: "ok" }),
  };
  const ctx = makeCtx({ ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0, fallbackAfterFailures: 1, fallbackMaxSwitches: 1 }, { llm });
  const agent = { id: "a30" };
  // Another session already proved beta/y works in this process.
  await ctx.fireRequest({ agent: { id: "a30-other" } }, { provider: "beta", model: "y" });
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  }
  const line = ctx._logs.find((l) => /model fallback: \S+ →/.test(l)) ?? "";
  ok(line.includes("qiniu/q → beta/q"), `the same model id on another provider leads (${line.slice(0, 80)}…)`);
}

console.log("== 31. a dead route (expired subscription) switches instead of waiting ==");
{
  const llm = {
    listProviders: async () => [{ id: "alpha" }, { id: "beta" }],
    listModels: async () => [{ id: "m" }],
    resolveModelInfo: async () => ({ id: "ok" }),
  };
  const ctx = makeCtx({ ...FAST, retries: 3, jitterRatio: 0, fallbackAfterFailures: 2, fallbackMaxSwitches: 2 }, { llm });
  const agent = { id: "a31" };
  await ctx.fireRequest({ agent }, { provider: "alpha", model: "m" });
  const decision = await ctx.fireRequestError(
    { agent, provider: "alpha", failure: { message: "Your subscription has expired", code: "AUTH" } }, undefined);
  ok(decision?.kind === "retry", "the retry is carried to another route");
  ok(ctx._logs.some((l) => /is unusable/.test(l)), "the dead route is named in the log");
  ok(ctx._logs.some((l) => /model fallback: alpha\/m → beta\/m/.test(l)), "it switched to the only other route");
  // Now beta dies too: alpha is remembered as dead, beta is tried, nothing left.
  const second = await ctx.fireRequestError(
    { agent, provider: "beta", failure: { message: "Your subscription has expired", code: "AUTH" } }, undefined);
  ok(second?.kind !== "retry", "with every route dead it stops instead of bouncing");
  ok(ctx._logs.some((l) => /no fallback route available for beta\/m/.test(l)), "and says so once");
}

console.log("== 32. throttling is congestion, not a dead end ==");
{
  const ctx = makeCtx({ ...FAST, retries: 2, jitterRatio: 0, fallbackAfterFailures: 1, fallbackMaxSwitches: 2 }, {});
  const agent = { id: "a32" };
  const decision = await ctx.fireRequestError(
    { agent, provider: "qiniu", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  ok(decision?.kind === "retry", "a throttled route is still retried in place");
  ok(!ctx._logs.some((l) => /is unusable/.test(l)), "and is never marked unusable");
}

console.log("== 33. the first request prints where a fallback would go ==");
{
  const llm = {
    listProviders: async () => [{ id: "alpha" }, { id: "beta" }],
    listModels: async () => [{ id: "m" }],
    resolveModelInfo: async () => ({ id: "ok" }),
  };
  const ctx = makeCtx({ ...FAST, jitterRatio: 0 }, { llm });
  const agent = { id: "a33" };
  await ctx.fireRequest({ agent }, { provider: "alpha", model: "m" });
  await ctx.fireRequest({ agent }, { provider: "alpha", model: "m" });
  const previews = ctx._logs.filter((l) => /model fallback preview/.test(l));
  ok(previews.length === 1, `the preview is printed once, not per request (${previews.length})`);
  ok(/would switch to beta\/m/.test(previews[0] ?? ""), "and names the route it would use");
}

console.log("== 34. fallbackAnyModel: false refuses to change the model itself ==");
{
  const llm = {
    listProviders: async () => [{ id: "alpha" }, { id: "beta" }],
    listModels: async () => [{ id: "m" }],
    resolveModelInfo: async () => ({ id: "ok" }),
  };
  // beta only has a different model, so nothing qualifies.
  const ctx = makeCtx({ ...FAST, jitterRatio: 0, retries: 1, fallbackAfterFailures: 1, fallbackAnyModel: false }, {
    llm: { ...llm, listModels: async (p) => (p === "alpha" ? [{ id: "m" }] : [{ id: "other" }]) },
  });
  const agent = { id: "a34" };
  await ctx.fireRequest({ agent }, { provider: "alpha", model: "m" });
  await delay(20); // the preview is fire-and-forget: it must never delay the request
  ok(ctx._logs.some((l) => /no candidate available/.test(l)), "the preview says there is nothing to fall back to");
  const decision = await ctx.fireRequestError(
    { agent, provider: "alpha", failure: { message: "Your subscription has expired", code: "AUTH" } }, undefined);
  ok(decision?.kind !== "retry", "so a dead route surfaces instead of silently changing the model");
}

console.log("== 35. a quiet stretch ALONE does not close an incident ==");
{
  // 1.8.1 corrects this: the plugin's own backoff can be longer than
  // `incidentGapMs` (a 180s rate-limit window against a 60s gap), so plain
  // silence between two failures proves nothing. Were it treated as recovery,
  // every long backoff would zero `incidentStartedAt` and neither
  // `retryUntilSuccessMaxMs` nor `fallbackAfterMs` could ever fire.
  const ctx = makeCtx({ ...FAST, retries: 3, jitterRatio: 0, incidentGapMs: 40 }, {});
  const agent = { id: "a35", session: { id: "s35" } };
  const payload = { agent, provider: "qiniu", model: "q", failure: { code: "TRANSPORT", message: "socket hang up" } };
  const first = await ctx.fireRequestError(payload, undefined);
  ok(first?.kind === "retry", "first failure is retried");
  ok(ctx._logs.some((l) => /retry 1\/3/.test(l)), "counted as attempt 1 of 3");
  await delay(60); // longer than incidentGapMs, but nothing was served
  await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  const second = await ctx.fireRequestError(payload, undefined);
  ok(second?.kind === "retry", "the later failure is still retried");
  ok(ctx._logs.some((l) => /retry 2\/3/.test(l)), "the count budget kept counting: silence alone reset nothing");
  ok(ctx._logs.some((l) => /retry 1\/3/.test(l)) && !ctx._logs.some((l) => /incident closed/.test(l)),
    "no incident-closed line was emitted");
}

console.log("== 44. session/event is (session, event), and a served message closes the incident ==");
{
  // The Host types this hook as 'session/event'(session: Session, event:
  // SessionEvent). A listener written against one wrapped payload object
  // matches nothing on a live Host — the 1.8.1 audit found exactly that, so the
  // turn-completion reset and the served-proof had both been dead code.
  const agent = { id: "a44", session: { id: "s44" } };
  const ctx = makeCtx({ ...FAST, retries: 3, jitterRatio: 0, incidentGapMs: 40 }, { agentsList: [agent] });
  const payload = { agent, provider: "qiniu", model: "q", failure: { code: "TRANSPORT", message: "socket hang up" } };
  await ctx.fireRequestError(payload, undefined);
  ok(ctx._logs.some((l) => /retry 1\/3/.test(l)), "attempt 1 of 3");
  await delay(60);
  // The route answered: one durable assistant message.
  await ctx.fireSessionEvent(agent.session, { type: "assistant/message", message: { id: "m1", role: "assistant", content: [] } });
  await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  const served = await ctx.fireRequestError(payload, undefined);
  ok(served?.kind === "retry", "still retried after a served request");
  ok(ctx._logs.filter((l) => /retry 1\/3/.test(l)).length === 2,
    "a served request plus a quiet stretch starts a fresh budget (attempt 1 again)");

  // A completed turn is the same signal, stronger: full reset.
  await ctx.fireSessionEvent(agent.session, { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } });
  const afterTurn = await ctx.fireRequestError(payload, undefined);
  ok(afterTurn?.kind === "retry", "a fresh contradiction after a completed turn is retried");
  ok(ctx._logs.filter((l) => /retry 1\/3/.test(l)).length === 3, "the completed turn reset the count budget too");

  // A completed request zeroes the until-success ceiling right away: a route
  // that is answering must never be declared dead by a clock that kept running
  // through its successful replies.
  const flapping = { id: "a44b", session: { id: "s44b" } };
  const ctxFlap = makeCtx({ ...FAST, retryUntilSuccess: true, retryUntilSuccessMaxMs: 400, retries: 1, jitterRatio: 0, incidentGapMs: 600000 }, { agentsList: [flapping] });
  const flapPayload = { agent: flapping, provider: "qiniu", model: "q", failure: { code: "TRANSPORT", message: "socket hang up" } };
  await ctxFlap.fireRequestError(flapPayload, undefined);
  await delay(200);
  await ctxFlap.fireSessionEvent(flapping.session, { type: "assistant/message", data: { turn: 1, step: 1, message: { id: "mF" } } });
  await delay(200);
  await ctxFlap.fireRequest({ agent: flapping }, { provider: "qiniu", model: "q" });
  const flap = await ctxFlap.fireRequestError(flapPayload, undefined);
  ok(flap?.kind === "retry",
    "a served answer restarted the until-success window, so a flapping route keeps retrying");

  // `max-tokens` is a successful ending as well: the route worked, the reply was
  // just cut by a token budget. An `error` ending must NOT reset anything.
  await ctx.fireSessionEvent(agent.session, { type: "turn/end", data: { turn: 4, reason: { kind: "max-tokens" } } });
  await ctx.fireRequestError(payload, undefined);
  ok(ctx._logs.filter((l) => /retry 1\/3/.test(l)).length === 4, "a max-tokens ending resets the budget, like completed");

  await ctx.fireRequestError(payload, undefined);
  ok(ctx._logs.some((l) => /retry 2\/3/.test(l)), "the counter climbed again after max-tokens");
  await ctx.fireSessionEvent(agent.session, { type: "turn/end", data: { turn: 5, reason: { kind: "error" } } });
  await ctx.fireRequestError(payload, undefined);
  ok(ctx._logs.some((l) => /retry 3\/3/.test(l)), "an error ending is NOT a reset: the count kept climbing");

  // An `interrupted: true` assistant anchor is a cancelled stream, not a
  // finished answer — the host appends one of those as well, and it must not be
  // mistaken for "the route worked".
  const agent2 = { id: "a45b", session: { id: "s45b" } };
  const ctx3 = makeCtx({ ...FAST, retries: 3, jitterRatio: 0, incidentGapMs: 40 }, { agentsList: [agent2] });
  const payload3 = { agent: agent2, provider: "qiniu", model: "q", failure: { code: "TRANSPORT", message: "socket hang up" } };
  await ctx3.fireRequestError(payload3, undefined);
  await delay(60);
  await ctx3.fireSessionEvent(agent2.session, { type: "assistant/message", data: { turn: 1, step: 1, interrupted: true, message: { id: "mI" } } });
  await ctx3.fireRequest({ agent: agent2 }, { provider: "qiniu", model: "q" });
  await ctx3.fireRequestError(payload3, undefined);
  ok(ctx3._logs.some((l) => /retry 2\/3/.test(l)),
    "an interrupted assistant frame does not count as a served request");
}

console.log("== 45. a success that PREDATES the failure is not proof of recovery ==");
{
  // The subtle half of the incident-clock fix: `servedAt` merely being non-zero
  // is not enough. If the route answered before it went bad, then hit a 180s
  // backoff, the stamp is still there — and a plain "servedAt is set" test would
  // close the incident on data that is older than the failure itself.
  const agent = { id: "a45", session: { id: "s45" } };
  const ctx = makeCtx({ ...FAST, retries: 4, jitterRatio: 0, incidentGapMs: 40 }, { agentsList: [agent] });
  const payload = { agent, provider: "qiniu", model: "q", failure: { code: "TRANSPORT", message: "socket hang up" } };
  await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  await ctx.fireSessionEvent(agent.session, { type: "assistant/message", message: { id: "mA", role: "assistant", content: [] } });
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "the failure after a good answer is retried");
  ok(ctx._logs.some((l) => /retry 1\/4/.test(l)), "counted as attempt 1 of 4");
  await delay(60); // quiet, but the last thing the route did was fail
  await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "the next failure is retried too");
  ok(ctx._logs.some((l) => /retry 2\/4/.test(l)),
    "the stamp predates the failure, so the incident clock was NOT cleared");
}

console.log("== 36. retryUntilSuccess (the 1.6.0 default): a blocked free model is retried until it gets through ==");
{
  // 老大's scenario (m01940): 免费模型容易堵塞 — hammer the SAME model inside the
  // same session until the request succeeds. Neither the retries count nor the
  // busy-route window may end the incident while the failure stays retryable.
  const ctx = makeCtx({ ...FAST, retryUntilSuccess: true, busyRouteBudgetMs: 400 });
  ok(ctx._logs.some((l) => /retry-until-success: on/.test(l)), "the mount line advertises retry-until-success");
  const agent = { id: "a36" };
  const payload = { agent, provider: "qiniu", failure: { code: "RATE_LIMIT", status: 429, message: "Too many requests for this free model" } };
  const decisions = [];
  for (let i = 0; i < 8; i++) decisions.push(await ctx.fireRequestError(payload, undefined));
  ok(decisions.every((d) => d?.kind === "retry"), "all 8 throttled attempts reconnect (no count budget in the way)");
  ok(ctx._logs.some((l) => /until-success #\d+/.test(l)), "past the count budget the log switches to until-success #N");
  ok(!ctx._logs.some((l) => /budget exhausted/.test(l)), "the incident is never declared exhausted");
  ok(!ctx._logs.some((l) => /model fallback: \S+ →/.test(l)), "relentless mode does not switch routes — it stays on this model");
}

console.log("== 37. relentless also covers plain disconnect blips, not only throttling ==");
{
  const ctx = makeCtx({ ...FAST, retryUntilSuccess: true });
  const agent = { id: "a37" };
  const payload = { agent, provider: "qiniu", failure: { code: "TRANSPORT", message: "socket hang up" } };
  const decisions = [];
  for (let i = 0; i < 5; i++) decisions.push(await ctx.fireRequestError(payload, undefined));
  ok(decisions.every((d) => d?.kind === "retry"), "a flaky link is retried past retries=2 as well");
  ok(ctx._logs.some((l) => /until-success #\d+ \(idle/.test(l)) === false, "a non-congested blip logs without the idle suffix");
}

console.log("== 38. retryUntilSuccess:false restores the 1.5.x budget behaviour ==");
{
  const ctx = makeCtx({ ...FAST, retryUntilSuccess: false, retries: 2, busyRouteBudgetMs: 600000, jitterRatio: 0 });
  ok(ctx._logs.some((l) => /busy-route budget: 600s/.test(l)), "the mount line falls back to the busy-route budget wording");
  const agent = { id: "a38" };
  const payload = { agent, provider: "qiniu", failure: { code: "TRANSPORT", message: "socket hang up" } };
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "attempt 1 retried");
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "attempt 2 retried");
  const third = await ctx.fireRequestError(payload, undefined);
  ok(third?.kind !== "retry", "attempt 3 is terminal again once the count budget is spent");
  ok(ctx._logs.some((l) => /budget exhausted .*count budget spent/.test(l)), "the refusal explains the count budget");
}

console.log("== 39. a definite error still stops everything, relentless or not ==");
{
  // 「不是一定的报错」 is the exception: auth/subscription failures answer the same
  // way forever, so the dead-route branch (which sits BEFORE the relentless gate)
  // must surface them instead of hammering.
  const ctx = makeCtx({ ...FAST, retryUntilSuccess: true, retries: 1, busyRouteBudgetMs: 60000 });
  const agent = { id: "a39" };
  const payload = { agent, provider: "qiniu", failure: { code: "AUTH", message: "Your subscription has expired" } };
  const first = await ctx.fireRequestError(payload, undefined);
  ok(first?.kind !== "retry", "an expired subscription is NOT retried even in relentless mode");
  ok(ctx._logs.some((l) => /is unusable \(the route reported AUTH\)/.test(l)), "the log names the dead-route reason");
  const second = await ctx.fireRequestError(payload, undefined);
  ok(second?.kind !== "retry", "the repeat failure is terminal too — no infinite hammer on a dead route");
  ok(!ctx._logs.some((l) => /until-success #\d+/.test(l)), "relentless never counted a dead-route attempt");
}

// ---------------------------------------------------------------------------
// 40. Control-panel HTTP API: the sidebar panel is only as good as these two
//     routes. A fake webCtx captures the registered handlers, then we drive
//     them with fake req/res objects — including the fence (403) path and the
//     whitelist (an unknown key must be rejected, not silently stored).
// ---------------------------------------------------------------------------
{
  const routes = new Map();
  let fenceRejection;
  const webCtx = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    connection: { requestRejection: () => fenceRejection },
    // cordis `effect(fn)` runs fn and keeps its disposer; the fake must run it
    // too, or the routes below are never actually registered.
    effect: (fn) => { const dispose = fn(); return dispose; },
  };
  const ctx = makeCtx({ ...FAST, retryUntilSuccess: true }, {
    inject: (deps, callback) => {
      ok(deps.includes("webServer") && deps.includes("connection"), "the panel api waits for webServer + connection");
      callback(webCtx);
    },
  });

  const statusHandler = routes.get("/auto-rerun/api/status");
  const configHandler = routes.get("/auto-rerun/api/config");
  ok(typeof statusHandler === "function" && typeof configHandler === "function",
    "both panel routes are registered");

  const call = (handler, { method = "GET", url = "", body } = {}) => new Promise((resolve) => {
    const chunks = [];
    const req = {
      method,
      url,
      on(event, fn) {
        if (event === "data" && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
        if (event === "end") fn();
        return req;
      },
    };
    const res = {
      status: 0,
      headers: {},
      body: "",
      writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
      end(payload) { this.body = payload ?? ""; resolve(this); },
    };
    handler(req, res);
  });

  // fence: an untrusted request must be refused before any work happens
  fenceRejection = 403;
  const blocked = await call(statusHandler, { url: "/auto-rerun/api/status" });
  ok(blocked.status === 403, "an untrusted request is fenced off with 403");
  ok(JSON.parse(blocked.body).ok === false, "the fenced response is an error envelope");

  fenceRejection = undefined;
  const status = await call(statusHandler, { url: "/auto-rerun/api/status" });
  const payload = JSON.parse(status.body);
  ok(status.status === 200 && payload.ok === true, "an authorized status read succeeds");
  ok(payload.value.mounted === true, "status reports the plugin as mounted");
  ok(payload.value.config.retryUntilSuccess === true, "status carries the live config");
  ok(typeof payload.value.stats.takeovers === "number", "status carries the counters");
  ok(Array.isArray(payload.value.log), "status carries the recent activity feed");
  ok(payload.value.log.some((l) => /mounted v/.test(l)), "the activity feed starts with the mount line");

  const patched = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { retryUntilSuccess: false, retries: 7 } },
  });
  const patchedBody = JSON.parse(patched.body);
  ok(patched.status === 200 && patchedBody.value.applied.retryUntilSuccess === false,
    "a panel switch writes the live config");
  ok(patchedBody.value.status.config.retries === 7, "the numeric setting lands too");

  // The panel exposes the two safety valves next to the "retry until it runs"
  // switch; a field the whitelist does not admit would render, accept typing,
  // and then silently do nothing. Both must round-trip through the same route.
  const valves = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { retryUntilSuccessMaxMs: 120000, fallbackAfterMs: 45000 } },
  });
  const valveBody = JSON.parse(valves.body);
  ok(valves.status === 200 && valveBody.value.status.config.retryUntilSuccessMaxMs === 120000,
    "the panel's retry-until-success ceiling is a live setting");
  ok(valveBody.value.status.config.fallbackAfterMs === 45000,
    "the panel's fallback window is a live setting");
  const negativeValve = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { retryUntilSuccessMaxMs: -5, fallbackAfterMs: "nonsense" } },
  });
  const negativeBody = JSON.parse(negativeValve.body);
  ok(negativeBody.value.status.config.retryUntilSuccessMaxMs === 0,
    "a negative ceiling clamps to 0 (= no ceiling) instead of disabling the whole valve silently");
  ok(negativeBody.value.status.config.fallbackAfterMs === 45000,
    "a non-numeric fallback window keeps the previous value rather than becoming NaN");

  const bad = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { messagePattern: "(.*)" } },
  });
  ok(bad.status === 400, "an unknown/unsafe key is refused, not stored");
  ok(/unknown setting/.test(JSON.parse(bad.body).error), "the refusal names the key as unknown");

  const wrongMethod = await call(configHandler, { method: "GET", url: "/auto-rerun/api/config" });
  ok(wrongMethod.status === 405, "the config route rejects GET");

  const missing = await call(statusHandler, { url: "/auto-rerun/api/nope" });
  ok(missing.status === 404, "an unknown panel endpoint is a 404");

  // The panel must show the plugin's real work, not a parallel bookkeeping
  // copy: drive a takeover and a refusal through the live listener, then read
  // the counters back over the same route the panel polls.
  const before = JSON.parse((await call(statusHandler, { url: "/auto-rerun/api/status" })).body).value.stats;
  // The earlier switch turned relentless mode OFF to prove the write lands; put
  // it back, because the assertion below is about the relentless takeover line.
  await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { retryUntilSuccess: true } },
  });
  const liveCtx = ctx;
  const agent = { id: "a40" };
  const throttled = { agent, provider: "qoder", failure: { code: "RATE_LIMIT", status: 503, message: "Qoder is busy — queued (retry in ~3s)" } };
  const firstTry = await liveCtx.fireRequestError(throttled, undefined);
  ok(firstTry?.kind === "retry", "a live takeover still returns retry with the panel mounted");
  const after = JSON.parse((await call(statusHandler, { url: "/auto-rerun/api/status" })).body).value.stats;
  ok(after.takeovers === before.takeovers + 1, "the takeover counter moves with real work");
  ok(after.agents >= 1, "status counts the agents it is tracking");
  const feed = JSON.parse((await call(statusHandler, { url: "/auto-rerun/api/status" })).body).value.log;
  // `until-success #N` only appears once the count budget is spent; with the
  // retries=7 this case wrote, the first takeovers still read `1/7`. Either
  // form proves the feed is carrying the real takeover line.
  ok(feed.some((l) => /retry \d+\/\d+|until-success #\d+/.test(l)), "the activity feed carries the takeover line the panel renders");
}

// ---------------------------------------------------------------------------
// 41. Panel API hardening found by the crash/bug audit:
//     a) a second mount whose routes are already taken must NOT throw out of
//        apply (that would take the retrying half down with the panel);
//     b) the sidebar's 选模型重试 toggle sends `modelFallback`, but only
//        `modelFallback.enabled` used to be whitelisted → the switch always
//        400'd. Both spellings must land;
//     c) `key in SETTINGS` admitted Object.prototype names, so a request could
//        write junk onto cfg; own keys only now;
//     d) an oversized body must be refused instead of buffered;
//     e) writing to a socket that already went away must not throw.
// ---------------------------------------------------------------------------
{
  const routes = new Map();
  let duplicate = true;
  const webCtx = {
    webServer: {
      register: (route) => {
        if (duplicate && routes.has(route.path)) {
          const error = new Error(`an exact route is already registered for ${route.path}`);
          throw error;
        }
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    connection: { requestRejection: () => undefined },
    effect: (fn) => { const dispose = fn(); return dispose; },
  };
  // First mount takes the routes; the second mount is the one that used to blow
  // up. Simulate it by pre-seeding the map with a sentinel.
  routes.set("/auto-rerun/api/status", () => {});

  let applied = true;
  try {
    makeCtx({ ...FAST, retryUntilSuccess: true }, {
      inject: (_deps, callback) => callback(webCtx),
    });
  } catch (cause) {
    applied = false;
    ok(false, `a duplicate panel route must not throw out of apply: ${cause?.message}`);
  }
  ok(applied, "a duplicate panel route does not take the plugin down");

  // Now a clean mount for the request-level assertions.
  routes.clear();
  duplicate = false;
  const ctx2 = makeCtx({ ...FAST, retryUntilSuccess: true }, {
    inject: (_deps, callback) => callback(webCtx),
  });
  const statusHandler = routes.get("/auto-rerun/api/status");
  const configHandler = routes.get("/auto-rerun/api/config");
  ok(typeof statusHandler === "function", "the clean mount still registers the status route");

  const call = (handler, { method = "GET", url = "", body, raw, res } = {}) => new Promise((resolve) => {
    const chunks = [];
    const req = {
      method,
      url,
      destroy() {},
      on(event, fn) {
        if (event === "data") {
          if (raw !== undefined) fn(Buffer.from(raw));
          else if (body !== undefined) fn(Buffer.from(JSON.stringify(body)));
        }
        if (event === "end") fn();
        return req;
      },
    };
    const response = res ?? {
      status: 0,
      body: "",
      writeHead(status) { this.status = status; },
      end(payload) { this.body = payload ?? ""; resolve(this); },
    };
    handler(req, response);
    if (res) resolve(res);
  });

  const alias = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { modelFallback: true } },
  });
  const aliasBody = JSON.parse(alias.body);
  ok(alias.status === 200 && aliasBody.value.applied.modelFallback === true,
    "the 选模型重试 toggle's own key name (`modelFallback`) is accepted");
  ok(aliasBody.value.status.config.modelFallback === true, "and it shows up in the config the panel renders");

  const dotted = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    body: { patch: { "modelFallback.enabled": false } },
  });
  ok(dotted.status === 200, "the dotted spelling still works too");

  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const proto = await call(configHandler, {
      method: "POST",
      url: "/auto-rerun/api/config",
      body: { patch: { [key]: 1 } },
    });
    ok(proto.status === 400, `a prototype key (${key}) is refused, not written onto cfg`);
  }
  const statusAfter = JSON.parse((await call(statusHandler, { url: "/auto-rerun/api/status" })).body);
  ok(statusAfter.value.config.constructor === Object,
    "cfg's prototype identity survived the prototype-key attempts");

  const huge = await call(configHandler, {
    method: "POST",
    url: "/auto-rerun/api/config",
    raw: "x".repeat((1 << 20) + 16),
  });
  ok(huge.status === 400 && /too large/.test(JSON.parse(huge.body).error),
    "an oversized body is refused instead of buffered");

  // A socket the peer already dropped: writing must not throw.
  const dead = { destroyed: true, writableEnded: false, writeHead() { throw new Error("should not be called"); }, end() { throw new Error("should not be called"); } };
  let threw = false;
  try {
    await call(statusHandler, { url: "/auto-rerun/api/status", res: dead });
  } catch { threw = true; }
  ok(!threw, "responding on a dead socket is silent, not a throw");

  // The feed/counters the panel reads must still be alive after all that.
  const alive = JSON.parse((await call(statusHandler, { url: "/auto-rerun/api/status" })).body);
  ok(alive.ok === true && typeof alive.value.stats.takeovers === "number",
    "the panel api is still healthy after the hostile requests");
}

console.log("== 41. settingsFile defaults to a portable path, never a machine-local one ==");
{
  // Publishing regression: an install on another machine must not inherit the
  // author's `D:\...` path. The default has to follow DSH's own data directory
  // rule (${DSH_HOME:-~/.dsh}), and `settingsFile: ""` must opt out entirely.
  const saved = process.env.DSH_HOME;
  try {
    delete process.env.DSH_HOME;
    const auto = mod.__mergeConfig({});
    ok(typeof auto.settingsFile === "string" && auto.settingsFile.endsWith("auto-rerun-settings.json"),
      `settingsFile defaults to the host data dir (${auto.settingsFile})`);
    ok(!/^[A-Za-z]:\\myproject|_scratch/.test(auto.settingsFile),
      "the default carries no author machine path");

    process.env.DSH_HOME = join(tmpdir(), "dsh-home-probe");
    const env = mod.__mergeConfig({});
    ok(env.settingsFile === join(tmpdir(), "dsh-home-probe", "auto-rerun-settings.json"),
      "DSH_HOME from the environment wins, exactly like the host resolves it");

    const off = mod.__mergeConfig({ settingsFile: "" });
    ok(off.settingsFile === undefined, 'settingsFile:"" keeps the toggles in memory');

    const besideLog = mod.__mergeConfig({ logFile: join(tmpdir(), "probe", "auto-rerun.log") });
    ok(besideLog.settingsFile === join(tmpdir(), "probe", "auto-rerun-settings.json"),
      "a configured logFile still parks the settings next to it");

    delete process.env.DSH_HOME;
    process.env.DSH_AUTO_RERUN_LOG = join(tmpdir(), "probe-env", "auto-rerun.log");
    const viaEnv = mod.__mergeConfig({});
    ok(viaEnv.logFile === join(tmpdir(), "probe-env", "auto-rerun.log"),
      "DSH_AUTO_RERUN_LOG opens file logging without editing config");
    ok(viaEnv.settingsFile === join(tmpdir(), "probe-env", "auto-rerun-settings.json"),
      "and the settings follow it, so a manual test writes one directory only");
  } finally {
    delete process.env.DSH_AUTO_RERUN_LOG;
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  }
}

console.log("== 42. retryUntilSuccess has a ceiling, so a hopeless route cannot hide forever ==");
{
  // "Keep retrying until it runs" is the point of the plugin, but "forever" is
  // not: a route that served nothing for the whole window is broken, and a
  // session that keeps whispering retries would hide the failure from the user.
  const ctx = makeCtx({ ...FAST, retries: 0, retryUntilSuccess: true, retryUntilSuccessMaxMs: 40, jitterRatio: 0 });
  ok(ctx._logs.some((l) => /stops only on dead-route errors or 0s without/.test(l)) === false,
    "the mount line converts the ceiling to seconds instead of printing a 0s window");
  ok(ctx._logs.some((l) => /or 0s? without a completed request/.test(l)) === false,
    "so a 40ms window never reads as an infinite one");
  const infinite = makeCtx({ ...FAST, retries: 0, retryUntilSuccess: true, retryUntilSuccessMaxMs: 0 });
  ok(infinite._logs.some((l) => /or never\)/.test(l)),
    "and an explicit 0 says never rather than 0s");
  const agent = { id: "a42" };
  const payload = { agent, provider: "qiniu", failure: { code: "TRANSPORT", message: "socket hang up" } };
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "inside the window it keeps retrying");
  await new Promise((r) => setTimeout(r, 60));
  const late = await ctx.fireRequestError(payload, undefined);
  ok(late?.kind !== "retry", "past the window the failure is allowed through");
  ok(ctx._logs.some((l) => /until-success window spent/.test(l)), "and the refusal names the spent window");
}

console.log("== 43. the 选模型重试 switch actually arms itself while retryUntilSuccess runs ==");
{
  // Regression: with retryUntilSuccess the count budget never runs out, so a
  // switch armed only on "budget spent" would never fire — the panel toggle
  // would silently do nothing. Time on one route is the signal that matters.
  const llm = {
    listProviders: async () => [{ id: "alpha" }, { id: "beta" }],
    listModels: async () => [{ id: "m" }],
    resolveModelInfo: async () => ({ id: "ok" }),
  };
  const ctx = makeCtx({ ...FAST, retries: 0, jitterRatio: 0, retryUntilSuccess: true, modelFallback: { enabled: true }, fallbackAfterFailures: 2, fallbackAfterMs: 30, fallbackMaxSwitches: 2 }, { llm });
  const agent = { id: "a43" };
  await ctx.fireRequest({ agent }, { provider: "alpha", model: "m" });
  const payload = { agent, provider: "alpha", failure: { code: "RATE_LIMIT", status: 429, message: "Too many requests" } };
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "the first failure is a plain retry");
  ok(!ctx._logs.some((l) => /model fallback: alpha\/m/.test(l)), "one failure is far too early to change the model");
  await new Promise((r) => setTimeout(r, 50));
  ok((await ctx.fireRequestError(payload, undefined))?.kind === "retry", "the failure that triggers a switch still recovers");
  ok(ctx._logs.some((l) => /model fallback: alpha\/m → beta\/m/.test(l)), "after the window the route is switched");
  ok(ctx._logs.some((l) => /consecutive failures over \d+s on this route/.test(l)), "and the reason states how long it kept failing");

  // Same failures, but a window that has not elapsed: nothing may switch.
  const patient = makeCtx({ ...FAST, retries: 0, jitterRatio: 0, retryUntilSuccess: true, modelFallback: { enabled: true }, fallbackAfterFailures: 1, fallbackAfterMs: 600000 }, { llm });
  const agent2 = { id: "a43b" };
  await patient.fireRequest({ agent: agent2 }, { provider: "alpha", model: "m" });
  for (let i = 0; i < 4; i++) await patient.fireRequestError({ agent: agent2, provider: "alpha", failure: { code: "RATE_LIMIT", status: 429, message: "Too many requests" } }, undefined);
  // The mount line itself contains the words "model fallback:", so the switch is
  // matched by its arrow, not by the phrase.
  ok(!patient._logs.some((l) => /model fallback: \S+ →/.test(l)), "a patient window keeps the chosen model even after repeated throttling");
}

console.log("== 46. a cyclic failure object cannot abort the retry hook ==");
{
  // Provider errors arrive with `cause` chains and response/socket references,
  // and `JSON.stringify` on one of those throws "Converting circular structure
  // to JSON". The debug line used to stringify the failure INSIDE the
  // agent/request-error listener, before the decision — a throw there would
  // have killed the one hook that is supposed to save the turn.
  const ctx = makeCtx({ ...FAST, debug: true });
  const failure = { code: "TRANSPORT", message: "socket hang up" };
  failure.self = failure;
  failure.response = { status: 502, request: { failure } };
  const r = await ctx.fireRequestError({ agent: { id: "a46" }, provider: "p", model: "m", failure }, undefined);
  ok(r?.kind === "retry", "a circular failure still gets retried instead of throwing out of the hook");
  ok(ctx._logs.some((l) => /request-error payload keys:/.test(l)), "and the debug line still prints what it could");

  // A failure that also cannot be turned into a string at all (a hostile
  // toString) must not take the hook down either.
  const hostile = { code: "TRANSPORT", message: "boom", toJSON() { throw new Error("no json for you"); } };
  const r2 = await ctx.fireRequestError({ agent: { id: "a46b" }, provider: "p", model: "m", failure: hostile }, undefined);
  ok(r2?.kind === "retry", "a failure whose toJSON throws is still retried");
}

console.log("== 47. humanMs keeps sub-second budgets readable in every log line ==");
{
  // A live run on 2026-10-30 logged "retry 1/3 in 0s" for a 400ms backoff:
  // Math.round(400 / 1000) is 0, so the operator reads "retries instantly"
  // while the plugin really waits. Every duration in a log line goes through
  // humanMs now, which keeps the unit honest below one second.
  const ctx = makeCtx({ ...FAST, retries: 3, initialDelayMs: 200, maxDelayMs: 200, jitterRatio: 0, busyRouteBudgetMs: 4000 });
  await ctx.fireRequestError({ agent: { id: "a47" }, provider: "p", model: "m", failure: { code: "TRANSPORT", message: "socket hang up" } }, undefined);
  const line = ctx._logs.at(-1) ?? "";
  ok(line.includes("in 200ms"), `the takeover line keeps the millisecond unit (${line.slice(-80)})`);
  ok(!/ in 0s /.test(line), "and never claims a zero-second wait");

  // The idle refusal carries durations too — same rule. Only a congested
  // failure (rate limit / retry-after hint) uses the idle budget, so this one
  // has to be throttled to reach that branch at all.
  const ctx2 = makeCtx({ ...FAST, retries: 1, initialDelayMs: 200, maxDelayMs: 200, jitterRatio: 0, rateLimitInitialDelayMs: 200, rateLimitMaxDelayMs: 200, busyRouteBudgetMs: 300 });
  const throttled = { code: "RATE_LIMIT", status: 429, message: "Too many requests" };
  await ctx2.fireRequestError({ agent: { id: "a47b" }, provider: "p", model: "m", failure: throttled }, undefined);
  await delay(400);
  await ctx2.fireRequestError({ agent: { id: "a47b" }, provider: "p", model: "m", failure: throttled }, undefined);
  const exhausted = ctx2._logs.find((l) => l.includes("budget exhausted")) ?? "";
  ok(/route idle for \d+ms > 300ms of reconnect budget/.test(exhausted), `the idle refusal prints ms below one second (${exhausted.slice(0, 140)})`);
}

console.log("== 48. a forced request is labelled with the route it really runs on ==");
{
  // Live Host, 2026-10-30: after `model fallback: deadroute/dead-model →
  // deadroute2/dead-model2` the very next takeover line still read
  // `provider=deadroute2 model=dead-model` — the provider was switched but the
  // model label came from the config the Host assembled BEFORE the override.
  // That label is not cosmetic: it is `routeOf()`, so the next failure is
  // attributed to a route that was never requested, gets blacklisted as a dead
  // route, and the switch-away repeats from the wrong "from".
  const cfg = {
    ...FAST, retries: 3, jitterRatio: 0, debug: true,
    // Relentless mode with an immediate time trigger: the count budget never
    // runs out there, so the switch has to be armed by `fallbackAfterMs`.
    retryUntilSuccess: true, retryUntilSuccessMaxMs: 0, fallbackAfterMs: 0,
    fallbackRoutes: ["beta/model-b"], fallbackAfterFailures: 1, fallbackMaxSwitches: 1,
  };
  const ctx = makeCtx(cfg);
  const agent = { id: "a48" };
  // The Host keeps rebuilding every request from its own frozen header: the
  // `agent/request` waterfall always arrives as alpha/model-a.
  const ask = () => ctx.fireRequest({ agent }, { provider: "alpha", model: "model-a" });
  await ask();
  const first = await ctx.fireRequestError(
    { agent, provider: "alpha", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  ok(first?.kind === "retry", "the throttled request is retried after the switch");
  const forced = await ask();
  ok(forced.provider === "beta" && forced.model === "model-b",
    `the request itself goes to the new route (${forced.provider}/${forced.model})`);
  ok(ctx._logs.some((l) => /fallback override applied: alpha\/model-a → beta\/model-b/.test(l)),
    "the debug line records the override");
  // The next failure must be labelled with beta/model-b, not the stale config.
  await ctx.fireRequestError(
    { agent, provider: "alpha", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  const takeovers = ctx._logs.filter((l) => l.includes("taking over"));
  const last = takeovers.at(-1) ?? "";
  ok(last.includes("route beta/model-b"),
    `the takeover after the switch names the forced route (${last.slice(0, 110)})`);
  ok(!last.includes("alpha"),
    "and never blames the route the plugin just left");
}

console.log("== 49. a host-owned switch keeps its guard armed against the stale assembled route ==");
{
  // Host regression, 2026-10-30: with `selectForNextRequest` the plugin used to
  // drop its own `agent/request` override at switch time. But the host only
  // refreshes `selection.assembled` at the next `system-prompt/assemble` — once
  // per STEP, never inside a step's retry loop — so its request-time listener
  // re-imposed the STALE route on every retry and burned the switch budget on
  // the route the plugin had just left. The override now stays armed until the
  // outgoing request actually carries the wanted route (host caught up) or
  // someone else moves the route (user moved it back).
  const cfg = {
    ...FAST, retries: 1, busyRouteBudgetMs: 60000, jitterRatio: 0,
    fallbackRoutes: ["backup/model-b"], fallbackAfterFailures: 1, fallbackMaxSwitches: 1, debug: true,
  };
  // A controller that accepts every switch → the host-owned path.
  const ctx = makeCtx(cfg, { sessionController: { agents: { selectForNextRequest: () => {} } } });
  const agent = { id: "a49" };
  for (let i = 0; i < 2; i++) {
    await ctx.fireRequestError(
      { agent, provider: "qiniu", model: "q", failure: { code: "RATE_LIMIT", status: 429, message: "tpm exhausted" } }, undefined);
  }
  ok(ctx._logs.join("\n").includes("model fallback: qiniu/q → backup/model-b"), "the host-owned switch is recorded");

  // The stale-assembled request: the host still hands out the OLD route, as it
  // will inside a step's retry loop until the next assemble. Before the fix
  // this passed through untouched and the turn died on the old route.
  const stale = await ctx.fireRequest({ agent }, { provider: "qiniu", model: "q" });
  ok(stale.provider === "backup" && stale.model === "model-b",
    `a stale pre-assemble request is still forced onto the new route (${stale.provider}/${stale.model})`);

  // Requests that already carry the wanted route prove the host caught up: the
  // override retires itself there, so a later user move is never fought.
  const caughtUp = await ctx.fireRequest({ agent }, { provider: "backup", model: "model-b" });
  ok(caughtUp.provider === "backup" && caughtUp.model === "model-b", "a request on the wanted route retires the guard");
  const moved = await ctx.fireRequest({ agent }, { provider: "third", model: "x" });
  ok(moved.provider === "third" && moved.model === "x", "a route moved by someone else is respected afterwards");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
