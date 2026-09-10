/* A minimal Chrome DevTools Protocol client, using only Node's stdlib.
 *
 * The tests drive a real headless Chromium and type with genuine key
 * events. Talking to it needs a WebSocket, and rather than depend on the
 * `ws` package (which would make these tests unrunnable from a fresh
 * checkout) this implements just the slice of RFC 6455 that CDP needs:
 * a client handshake, masked text frames out, unfragmented frames in.
 */
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { URL } = require("url");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function httpJSON(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

/** Open a CDP session against the first page whose URL contains `match`. */
async function connect({ port = 9222, match = "", timeout = 20000 } = {}) {
  const targets = await httpJSON(port, "/json/list");
  const target = targets.find(
    (t) => t.type === "page" && t.url.includes(match) && t.webSocketDebuggerUrl);
  if (!target) throw new Error(`no page matching "${match}"`);

  const url = new URL(target.webSocketDebuggerUrl);
  const key = crypto.randomBytes(16).toString("base64");
  const accept = crypto.createHash("sha1")
    .update(key + GUID).digest("base64");

  const sock = net.connect(Number(url.port) || 80, url.hostname);
  sock.setNoDelay(true);

  const leftover = await new Promise((resolve, reject) => {
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    // Read just the handshake response, then hand the rest to the framer.
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.slice(0, end).toString();
      if (!/HTTP\/1\.1 101/.test(head)) {
        sock.removeListener("data", onData);
        return reject(new Error("handshake failed: " + head.split("\r\n")[0]));
      }
      if (!head.toLowerCase().includes(accept.toLowerCase())) {
        sock.removeListener("data", onData);
        return reject(new Error("bad Sec-WebSocket-Accept"));
      }
      sock.removeListener("data", onData);
      // Anything after the handshake is already websocket frames.
      const rest = buf.slice(end + 4);
      resolve(rest);
    };
    sock.on("data", onData);
  });

  // ---- framing ----------------------------------------------------

  let inbox = leftover && leftover.length ? leftover : Buffer.alloc(0);
  const pending = new Map();
  const listeners = [];
  let id = 0;
  let closed = false;

  function frame(payload) {
    const data = Buffer.from(payload, "utf8");
    const mask = crypto.randomBytes(4);
    const n = data.length;
    let header;
    if (n < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | n;
    } else if (n < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(n, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(n), 2);
    }
    header[0] = 0x81;                      // FIN + text
    const masked = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) masked[i] = data[i] ^ mask[i & 3];
    return Buffer.concat([header, mask, masked]);
  }

  function drain() {
    for (;;) {
      if (inbox.length < 2) return;
      const len0 = inbox[1] & 0x7f;
      let offset = 2, len = len0;
      if (len0 === 126) {
        if (inbox.length < 4) return;
        len = inbox.readUInt16BE(2); offset = 4;
      } else if (len0 === 127) {
        if (inbox.length < 10) return;
        len = Number(inbox.readBigUInt64BE(2)); offset = 10;
      }
      if (inbox.length < offset + len) return;

      const opcode = inbox[0] & 0x0f;
      const payload = inbox.slice(offset, offset + len);
      inbox = inbox.slice(offset + len);

      if (opcode === 0x8) { closed = true; sock.end(); return; }
      if (opcode === 0x9) {                 // ping -> pong
        const pong = frame(payload.toString());
        pong[0] = 0x8a;
        sock.write(pong);
        continue;
      }
      if (opcode !== 0x1 && opcode !== 0x0) continue;

      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { continue; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else {
        for (const fn of listeners) fn(msg);
      }
    }
  }

  sock.on("data", (chunk) => { inbox = Buffer.concat([inbox, chunk]); drain(); });

  function send(method, params = {}) {
    if (closed) return Promise.reject(new Error("socket closed"));
    const i = ++id;
    return new Promise((resolve, reject) => {
      pending.set(i, { resolve, reject });
      sock.write(frame(JSON.stringify({ id: i, method, params })));
      setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i);
          reject(new Error("timeout: " + method));
        }
      }, timeout);
    });
  }

  // ---- conveniences ------------------------------------------------

  /** Evaluate an expression in the page and return its value. */
  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("page threw: " + JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }

  /** Press a printable character through the real key pipeline. */
  async function type(ch) {
    const code = ch === " " ? "Space" : "Key" + ch.toUpperCase();
    const kc = ch === " " ? 32 : ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", {
      type: "keyDown", text: ch, key: ch, code,
      windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, code,
      windowsVirtualKeyCode: kc, nativeVirtualKeyCode: kc,
    });
  }

  async function typeString(s, delay = 8) {
    for (const ch of s) { await type(ch); await sleep(delay); }
  }

  async function setViewport(width, height = 820) {
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }

  const clearViewport = () => send("Emulation.clearDeviceMetricsOverride");

  async function screenshot(file, clip) {
    const r = await send("Page.captureScreenshot",
      clip ? { format: "png", clip } : { format: "png" });
    require("fs").writeFileSync(file, Buffer.from(r.data, "base64"));
  }

  return {
    send, evaluate, type, typeString, setViewport, clearViewport, screenshot,
    on: (fn) => listeners.push(fn),
    close: () => { closed = true; sock.end(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tiny assertion collector shared by the test scripts. */
function results() {
  const rows = [];
  return {
    ok(name, cond, detail = "") {
      rows.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
    },
    report() {
      console.log(rows.join("\n"));
      const passed = rows.filter((r) => r.startsWith("PASS")).length;
      console.log(`\n${passed}/${rows.length} passed`);
      return rows.every((r) => r.startsWith("PASS"));
    },
  };
}

module.exports = { connect, sleep, results };
