const assert = require("node:assert/strict");
const test = require("node:test");

// The tracker reads the last received message from MySQL on creation; tests answer from memory.
const pool = require("../src/connection.ts").default;
let storedTimestamp = null;
pool.query = async () => [[{ LAST_TIMESTAMP: storedTimestamp }], []];

const {
  SessionBusyError,
  SessionTracker,
  waitUntil,
} = require("../src/session-status.ts");

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("follows the pairing lifecycle", () => {
  const tracker = new SessionTracker("acme", "default", "BAILEYS");
  assert.equal(tracker.snapshot({ auth: false, ready: false }).state, "STARTING");

  tracker.qrReceived("2@abc");
  let status = tracker.snapshot({ auth: false, ready: false });
  assert.equal(status.state, "QR_PENDING");
  assert.equal(status.qr, "2@abc");
  assert.ok(status.qrAt);

  tracker.connected("5511999999999", "Acme");
  status = tracker.snapshot({ auth: true, ready: true });
  assert.equal(status.state, "CONNECTED");
  assert.equal(status.qr, null);
  assert.equal(status.phone, "5511999999999");
  assert.equal(status.pushName, "Acme");
  assert.ok(status.connectedAt);
  assert.equal(status.client, "acme");
  assert.equal(status.number, "default");
  assert.equal(status.type, "BAILEYS");

  tracker.disconnected("Connection Lost (code 408)");
  status = tracker.snapshot({ auth: false, ready: false });
  assert.equal(status.state, "DISCONNECTED");
  assert.equal(status.connectedAt, null);
  assert.equal(status.lastDisconnectReason, "Connection Lost (code 408)");
  assert.equal(status.phone, "5511999999999", "keeps the last paired number");

  tracker.loggedOut();
  assert.equal(tracker.snapshot({ auth: false, ready: false }).phone, null);
});

test("keeps the session start while reconnect events repeat", () => {
  const tracker = new SessionTracker("acme", "default", "ZAPO");
  tracker.connected("5511999999999", null);
  const firstConnectedAt = tracker.connectedAt;

  tracker.connected(null, null);
  assert.equal(tracker.connectedAt, firstConnectedAt);
  assert.equal(tracker.phone, "5511999999999");
});

test("normalizes message timestamps and keeps the latest", () => {
  const tracker = new SessionTracker("acme", "default", "BAILEYS");
  const seconds = Math.floor(Date.UTC(2026, 8, 30, 12) / 1000);

  tracker.messageReceived(seconds);
  assert.equal(tracker.lastReceivedAt.toISOString(), "2026-09-30T12:00:00.000Z");

  tracker.messageReceived({ toNumber: () => seconds - 60 });
  assert.equal(
    tracker.lastReceivedAt.toISOString(),
    "2026-09-30T12:00:00.000Z",
    "an older history message does not move the date back",
  );

  tracker.messageReceived(Date.UTC(2026, 8, 30, 13));
  assert.equal(tracker.lastReceivedAt.toISOString(), "2026-09-30T13:00:00.000Z");

  const before = Date.now();
  tracker.messageSent(Date.now() + 86_400_000);
  assert.ok(tracker.lastSentAt.getTime() <= Date.now(), "future dates are capped at now");
  assert.ok(tracker.lastSentAt.getTime() >= before);
});

test("rejects a second action while one is running", async () => {
  const tracker = new SessionTracker("acme", "default", "BAILEYS");
  let release;
  const running = tracker.runAction("RESTART", () => new Promise((resolve) => (release = resolve)));

  assert.equal(tracker.snapshot({ auth: false, ready: false }).action, "RESTART");
  await assert.rejects(tracker.runAction("LOGOUT", async () => {}), SessionBusyError);

  release();
  await running;
  assert.equal(tracker.action, null);

  await assert.rejects(
    tracker.runAction("LOGOUT", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(tracker.action, null, "a failed action releases the lock");
});

test("loads the last received message from the local messages table", async () => {
  storedTimestamp = String(Date.UTC(2026, 8, 29, 10));
  const tracker = new SessionTracker("acme", "default", "BAILEYS");
  await flush();

  assert.equal(tracker.lastReceivedAt.toISOString(), "2026-09-29T10:00:00.000Z");
  storedTimestamp = null;
});

test("waitUntil reports whether the condition happened in time", async () => {
  let done = false;
  setTimeout(() => (done = true), 50);

  assert.equal(await waitUntil(() => done, 2_000), true);
  assert.equal(await waitUntil(() => false, 300), false);
});
