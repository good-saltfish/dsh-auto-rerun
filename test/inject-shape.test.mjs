// Regression test for the injection invariant: every message this plugin puts
// into a live session must survive the host's cold-restore validator.
//
// Why this exists: `agent.followup()` persists whatever object it is handed and
// validates nothing, while replaying the session later DOES validate — a
// `user/message` event without a non-empty `message.id` (string) and
// `role: "user"` throws "session event at seq N lacks an identified message"
// and the WHOLE session stops opening, history included. Released 1.1.1 hit
// exactly that with a bare `{ content, source }`; this test is the guard that
// keeps it from coming back through any future call site.
//
// Run: node --test test/   (from the plugin directory)

import { test } from "node:test";
import assert from "node:assert/strict";

const mod = await import(new URL("../index.js", import.meta.url));
const { __buildUserMessage: buildUserMessage, __unidentifiedReason: unidentifiedReason, __admitFollowup: admitFollowup } = mod;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The defect the host validator rejects, written the way `assertMessageEventShape`
 * checks it for a `user/message` event: an object, a non-empty string id, the
 * matching role, and (as the host also requires) array content plus a source
 * with a non-empty kind.
 *
 * @param {unknown} message - candidate message.
 * @returns {void}
 * @throws {Error} when replaying the session would reject this event.
 */
function assertMessageEventShape(message) {
  if (!message || typeof message !== "object") throw new Error("lacks an identified message");
  if (typeof message.id !== "string" || message.id === "") throw new Error("lacks an identified message");
  if (message.role !== "user") throw new Error('message must have role "user"');
  if (!Array.isArray(message.content)) throw new Error("message has invalid content");
  if (!message.source || typeof message.source !== "object" || typeof message.source.kind !== "string" || message.source.kind === "") {
    throw new Error("message has invalid source");
  }
}

test("buildUserMessage returns a complete identified UserMessage", async () => {
  const message = await buildUserMessage({
    content: [{ type: "text", text: "x" }],
    source: { kind: "auto-rerun" },
  });
  assert.match(message.id, UUID_RE, "id must be a real UUID string");
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, [{ type: "text", text: "x" }], "content must pass through unchanged");
  assert.equal(message.source.kind, "auto-rerun", "source.kind is load-bearing for the host validator");
  assert.equal(unidentifiedReason(message), null, "the built message must be judged fit");
  assertMessageEventShape(message);
});

test("a bare { content, source } is rejected — that is what corrupted sessions", async () => {
  const bare = { content: [{ type: "text", text: "x" }], source: { kind: "auto-rerun" } };
  assert.notEqual(unidentifiedReason(bare), null, "the guard must flag an id-less message");
  assert.throws(() => assertMessageEventShape(bare), /lacks an identified message/);
});

test("each injected message gets its own id", async () => {
  const a = await buildUserMessage({ content: [{ type: "text", text: "a" }], source: { kind: "auto-rerun" } });
  const b = await buildUserMessage({ content: [{ type: "text", text: "b" }], source: { kind: "auto-rerun" } });
  assert.notEqual(a.id, b.id, "reusing an id would collide in the session log");
});

test("an incomplete build is repaired, never persisted as-is", async () => {
  // The host module is absent in this environment (and could in principle hand
  // back something partial): the identity must be backfilled rather than
  // trusted, because the damage is done at write time and only visible at
  // replay time.
  const message = await buildUserMessage({ content: [{ type: "text", text: "c" }], source: { kind: "auto-rerun" }, id: "" });
  assert.match(message.id, UUID_RE);
  assert.equal(message.role, "user");
  assert.equal(unidentifiedReason(message), null);
});

test("a missing or malformed source is normalized, not dropped", async () => {
  const message = await buildUserMessage({ content: [{ type: "text", text: "d" }], source: undefined });
  assert.equal(message.source.kind, "auto-rerun", "an invalid source rejects the whole session just like a missing id");
  assertMessageEventShape(message);
});

test("unidentifiedReason flags every shape the validator rejects", () => {
  const good = { id: "u1", role: "user", content: [], source: { kind: "auto-rerun" } };
  assert.equal(unidentifiedReason(good), null);
  assert.match(unidentifiedReason(null) ?? "", /object/);
  assert.match(unidentifiedReason({ ...good, id: "" }) ?? "", /id/);
  assert.match(unidentifiedReason({ ...good, id: 42 }) ?? "", /id/);
  assert.match(unidentifiedReason({ ...good, role: "assistant" }) ?? "", /role/);
  assert.match(unidentifiedReason({ ...good, content: "text" }) ?? "", /content/);
  assert.match(unidentifiedReason({ ...good, source: { kind: "" } }) ?? "", /source/);
});

test("admitFollowup injects an identified message and surfaces followup errors", async () => {
  const injected = [];
  const agent = { followup: (message) => injected.push(message) };
  await admitFollowup(agent, {
    content: [{ type: "text", text: "e" }],
    source: { kind: "auto-rerun", form: "notice", summary: "auto-rerun attempt 1" },
  });
  assert.equal(injected.length, 1);
  assertMessageEventShape(injected[0]);
  assert.equal(injected[0].source.form, "notice", "the chat shows it as a collapsed notice with the summary as its one-line account");
  assert.equal(injected[0].source.summary, "auto-rerun attempt 1");

  // A host followup that throws must surface to the caller (scheduleRerun
  // catches it and logs) — never swallowed, never retried as a bare object.
  await assert.rejects(
    () => admitFollowup({ followup: () => { throw new Error("boom"); } }, {
      content: [{ type: "text", text: "f" }],
      source: { kind: "auto-rerun" },
    }),
    /boom/,
  );
});
