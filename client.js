/**
 * dsh-auto-rerun — browser half.
 *
 * Registers one tab in the right sidebar through dsh-better-sidebar's
 * `registerTab` service. The panel is a thin viewer/controller over the host
 * half: every number it shows and every switch it flips goes through the
 * plugin's own host routes (`/auto-rerun/api/*`), so what the panel reports is
 * what the running plugin actually does — no second source of truth.
 *
 * Loaded by the DSH client module loader: `window.__ModuleLoader__.load(...)`.
 * The manifest side is package.json `dsh.client` + `exports["./client"]`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-auto-rerun',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/auto-rerun/api';
    const POLL_MS = 2000;

    // Theme tokens only: the panel has to read correctly in light and dark
    // beside host pages, and every token below has an inline fallback so an
    // older shell still renders something legible.
    const BORDER = '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))';
    const LABEL = 'var(--dsw-alias-label-primary, inherit)';
    const MUTED = 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.95))';
    const DANGER = 'var(--dsw-alias-label-danger, #c0392b)';

    const S = {
      card: {
        border: BORDER,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        padding: '10px 12px',
        marginBottom: 10,
        background: 'transparent',
      },
      title: { color: LABEL, fontSize: 14, fontWeight: 600, margin: 0 },
      label: { color: LABEL, fontSize: 13, lineHeight: '20px' },
      hint: { color: MUTED, fontSize: 12, lineHeight: '18px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between', padding: '4px 0' },
      num: {
        width: 92,
        padding: '3px 6px',
        fontSize: 12,
        color: LABEL,
        background: 'transparent',
        border: BORDER,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        fontVariantNumeric: 'tabular-nums',
      },
      btn: {
        padding: '3px 10px',
        fontSize: 12,
        color: LABEL,
        background: 'transparent',
        border: BORDER,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        cursor: 'pointer',
      },
      log: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 11,
        lineHeight: '16px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 220,
        overflowY: 'auto',
        margin: 0,
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
    };

    function badge(tone, text) {
      const color = tone === 'bad' ? DANGER : 'var(--dsw-alias-label-success, #2e7d32)';
      return h('span', {
        style: {
          display: 'inline-block',
          padding: '0 6px',
          borderRadius: 999,
          fontSize: 11,
          lineHeight: '18px',
          color,
          border: '0.5px solid currentColor',
        },
      }, text);
    }

    /** Route URL: prefer the sidebar service's absolute URL (it keeps a
     *  reverse-proxy prefix), but only when it is same-origin — a GUI opened
     *  through a LAN address would otherwise poll a 127.0.0.1 URL and fail with
     *  no credentials. The relative path is the fallback because both halves are
     *  served by the same host. */
    function urlFor(ctx, path) {
      const svc = ctx && (ctx.betterSidebar || (ctx.get && ctx.get('betterSidebar')));
      try {
        const built = svc && svc.hostRouteUrl ? svc.hostRouteUrl(path) : undefined;
        if (typeof built === 'string' && built) {
          const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
          const parsed = new URL(built, origin);
          if (origin === undefined || parsed.origin === origin) return parsed.href;
        }
      } catch { /* fall through to the relative path */ }
      return path;
    }

    async function callJson(ctx, path, init) {
      const response = await fetch(urlFor(ctx, path), { credentials: 'same-origin', ...init });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { ok: false, error: text.slice(0, 400) };
      }
      if (!response.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + response.status);
      if (body && body.ok === false) throw new Error(body.error || 'request rejected');
      return body && 'value' in body ? body.value : body;
    }

    /** A numeric field that commits on blur/Enter, so typing never fires one
     *  config write per keystroke. */
    function NumberField(props) {
      const [draft, setDraft] = React.useState(String(props.value == null ? '' : props.value));
      React.useEffect(() => { setDraft(String(props.value == null ? '' : props.value)); }, [props.value]);
      const commit = () => {
        const next = Number(draft);
        if (!Number.isFinite(next)) { setDraft(String(props.value)); return; }
        const lo = props.min == null ? 0 : props.min;
        const hi = props.max == null ? Number.MAX_SAFE_INTEGER : props.max;
        const clamped = Math.min(hi, Math.max(lo, next));
        setDraft(String(clamped));
        if (clamped !== props.value) props.onCommit(clamped);
      };
      const label = h('div', null,
        h('div', { style: S.label }, props.label),
        props.hint ? h('div', { style: S.hint }, props.hint) : null);
      const input = h('input', {
        style: S.num,
        type: 'number',
        value: draft,
        min: props.min,
        max: props.max,
        step: props.step,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
      });
      return h('div', { style: S.row }, label, input);
    }

    function Toggle(props) {
      const label = h('div', null,
        h('div', { style: S.label }, props.label),
        props.hint ? h('div', { style: S.hint }, props.hint) : null);
      const input = h('input', {
        type: 'checkbox',
        checked: !!props.checked,
        disabled: !!props.disabled,
        style: { width: 16, height: 16, cursor: props.disabled ? 'default' : 'pointer' },
        onChange: (event) => props.onChange(event.target.checked),
      });
      return h('div', { style: S.row }, label, input);
    }

    function headerCard(status, stats) {
      const title = h('div', null,
        h('div', { style: S.title }, '自动重跑'),
        h('div', { style: S.hint }, 'v' + (status.version || '?') + ' · 已运行 ' + Math.round((stats.uptimeMs || 0) / 1000) + 's'));
      return h('div', { style: { ...S.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
        title,
        badge(status.mounted ? 'ok' : 'bad', status.mounted ? '运行中' : '未挂载'));
    }

    function switchesCard(cfg, busy, patch) {
      return h('div', { style: S.card },
        h(Toggle, {
          label: '一直重试直到跑通',
          hint: '同一模型同一会话内，非死路报错就无限重连（退避仍封顶）。关掉则回到计数/时间预算制。',
          checked: cfg.retryUntilSuccess !== false,
          disabled: busy,
          onChange: (next) => patch({ retryUntilSuccess: next }),
        }),
        h(Toggle, {
          label: '选模型重试',
          hint: '当前路线失败太多次时换一条路线继续（会写 model/selection，界面上会提示模型已切换）。',
          checked: cfg.modelFallback === true,
          disabled: busy,
          onChange: (next) => patch({ modelFallback: next }),
        }),
        h(Toggle, {
          label: '调试日志',
          hint: '把候选预演、守卫注册等细节写进日志文件。',
          checked: cfg.debug === true,
          disabled: busy,
          onChange: (next) => patch({ debug: next }),
        }));
    }

    function numbersCard(cfg, patch) {
      return h('div', { style: S.card },
        h(NumberField, {
          label: '重试次数预算',
          hint: '仅「一直重试」关闭时生效',
          value: cfg.retries, min: 0, max: 50,
          onCommit: (next) => patch({ retries: next }),
        }),
        h(NumberField, {
          label: '回合级续跑次数',
          hint: '回合已经死掉后，再补一次消息让它继续',
          value: cfg.reruns, min: 0, max: 20,
          onCommit: (next) => patch({ reruns: next }),
        }),
        h(NumberField, {
          label: '续跑延迟 (ms)',
          value: cfg.rerunDelayMs, min: 0, max: 600000, step: 500,
          onCommit: (next) => patch({ rerunDelayMs: next }),
        }),
        h(NumberField, {
          label: '事故边界 (ms)',
          hint: '这么久没有新失败、且中间真的答过一条请求，才认为事故结束、预算归零',
          value: cfg.incidentGapMs, min: 0, max: 3600000, step: 5000,
          onCommit: (next) => patch({ incidentGapMs: next }),
        }),
        // The two safety valves below are the reason "retry forever" cannot
        // turn a dead route into a silently stuck session, so they belong on
        // the panel next to the switch that depends on them.
        h(NumberField, {
          label: '一直重试上限 (ms)',
          hint: '这么久一条请求都没跑通就把错误交还宿主；0 = 不设上限',
          value: cfg.retryUntilSuccessMaxMs, min: 0, max: 86400000, step: 60000,
          onCommit: (next) => patch({ retryUntilSuccessMaxMs: next }),
        }),
        h(NumberField, {
          label: '换路线时限 (ms)',
          hint: '同一路线连续失败这么久才允许换模型（一直重试时唯一的触发信号）',
          value: cfg.fallbackAfterMs, min: 0, max: 3600000, step: 10000,
          onCommit: (next) => patch({ fallbackAfterMs: next }),
        }),
        h(NumberField, {
          label: '拥塞预算 (ms)',
          hint: '仅「一直重试」关闭时生效：路线一直忙时最多陪它等这么久',
          value: cfg.busyRouteBudgetMs, min: 0, max: 3600000, step: 30000,
          onCommit: (next) => patch({ busyRouteBudgetMs: next }),
        }));
    }

    function statsCard(stats, route) {
      const head = h('div', {
        style: { ...S.row, borderBottom: BORDER, paddingBottom: 6 },
      },
      h('div', { style: S.label }, '本次进程累计'),
      h('span', { style: S.hint }, '当前路线 ' + (route.label || '未知')));

      const rows = [
        ['接管重连', stats.takeovers],
        ['拒绝重连', stats.refusals],
        ['回合续跑', stats.reruns],
        ['换路线', stats.switches],
        ['死路命中', stats.deadRoutes],
      ].map((pair) => h('div', { key: pair[0], style: S.row },
        h('div', { style: S.label }, pair[0]),
        h('div', { style: { ...S.label, fontVariantNumeric: 'tabular-nums' } }, String(pair[1] == null ? 0 : pair[1]))));

      return h('div', { style: S.card }, [head].concat(rows));
    }

    function activityCard(lines, error, refresh) {
      const head = h('div', { style: S.row },
        h('div', { style: S.label }, '最近活动'),
        h('button', { style: S.btn, onClick: refresh }, '刷新'));
      const problem = error ? h('div', { style: { ...S.hint, color: DANGER } }, error) : null;
      // Never assume the host answered with the shape we expect: a `.join` on a
      // non-array throws during render, and without a boundary that blanks the
      // whole sidebar, not just this tab.
      const rows = Array.isArray(lines) ? lines.filter((line) => typeof line === 'string') : [];
      const body = h('pre', { style: S.log }, rows.length ? rows.join('\n') : '还没有活动。');
      return h('div', { style: S.card }, [head, problem, body].filter(Boolean));
    }

    /** Last line of defence: a render throw inside a tab must not take the
     *  host's sidebar down with it. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false, message: '' };
      }
      static getDerivedStateFromError(cause) {
        return { failed: true, message: String(cause && cause.message ? cause.message : cause) };
      }
      componentDidCatch(cause) {
        this.props.onError && this.props.onError(cause);
      }
      render() {
        if (this.state.failed) {
          return h('div', { style: { padding: 12, color: DANGER, fontSize: 13 } },
            '面板渲染出错：' + this.state.message,
            h('div', { style: { ...S.hint, marginTop: 6 } }, '插件本身仍在后台重试，关掉再打开这个标签页即可。'));
        }
        return this.props.children;
      }
    }

    function Panel(props) {
      const ctx = props.ctx;
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [tick, setTick] = React.useState(0);

      const load = React.useCallback(async () => {
        try {
          const next = await callJson(ctx, API + '/status');
          setStatus(next);
          setError('');
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        }
      }, [ctx]);

      // A collapsed/closed tab stays mounted in some shells; polling the host
      // every two seconds for a panel nobody is looking at is pure noise.
      const visible = props.visible !== false;
      React.useEffect(() => {
        if (!visible) return undefined;
        let live = true;
        const pull = () => { if (live) void load(); };
        pull();
        const timer = setInterval(pull, POLL_MS);
        return () => { live = false; clearInterval(timer); };
      }, [load, tick, visible]);

      const patch = React.useCallback(async (delta) => {
        setBusy(true);
        try {
          const next = await callJson(ctx, API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: delta }),
          });
          if (next && next.status) setStatus(next.status);
          setError('');
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
        } finally {
          setBusy(false);
        }
      }, [ctx]);

      const refresh = () => setTick((n) => n + 1);

      if (!status) {
        const message = error ? '面板读不到插件状态：' + error : '正在读取插件状态…';
        return h('div', { style: { padding: 12 } },
          h('div', { style: S.hint }, message),
          h('button', { style: { ...S.btn, marginTop: 8 }, onClick: refresh }, '重试'));
      }

      const cfg = status && typeof status === 'object' ? status.config || {} : {};
      const stats = status && typeof status === 'object' ? status.stats || {} : {};
      const route = status && typeof status === 'object' ? status.route || {} : {};
      const lines = status && typeof status === 'object' ? status.log || [] : [];

      return h('div', { style: { padding: 12, overflowY: 'auto' } }, [
        headerCard(status, stats),
        switchesCard(cfg, busy, patch),
        numbersCard(cfg, patch),
        statsCard(stats, route),
        activityCard(lines, error, refresh),
      ]);
    }

    return {
      inject: ['betterSidebar'],
      apply(ctx) {
        const service = ctx.betterSidebar || (ctx.get && ctx.get('betterSidebar'));
        if (!service || !service.registerTab) {
          ctx.logger?.warn?.('auto-rerun: betterSidebar service is missing; the panel stays unmounted');
          return;
        }
        const dispose = service.registerTab({
          id: 'auto-rerun:panel',
          title: () => '自动重跑',
          description: '自动重跑插件的运行状态与开关',
          order: 60,
          single: true,
          component: (tabProps) => h(PanelBoundary, {
            onError: (cause) => ctx.logger?.warn?.(`auto-rerun: panel render failed: ${cause && cause.message ? cause.message : cause}`),
          }, h(Panel, { ...tabProps, ctx })),
        });
        ctx.effect(() => dispose);
      },
    };
  },
});
