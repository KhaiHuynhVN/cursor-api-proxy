/**
 * Direct Cursor API client - bypasses CLI for fast streaming.
 * 
 * Flow:
 * 1. captureContext() - runs CLI once to intercept the context envelope
 * 2. streamDirect() - sends request with cached context via HTTP/2
 * 
 * Protocol: agent.v1.AgentService/Run (BiDi streaming, connect+proto)
 * Endpoint: agentn.global.api5.cursor.sh
 */

import * as http2 from "node:http2";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";
import { logError, logEvent } from "./error-log.js";

// ─── Protobuf helpers ───

function encodeVarint(v: number): Buffer {
  const b: number[] = [];
  v >>>= 0;
  while (v >= 0x80) { b.push((v & 0x7f) | 0x80); v >>>= 7; }
  b.push(v & 0x7f);
  return Buffer.from(b);
}

function decodeVarint(buf: Buffer, pos: number): [number, number] {
  let r = 0, s = 0;
  while (pos < buf.length) {
    const b = buf[pos]; r |= (b & 0x7f) << s; s += 7; pos++;
    if (!(b & 0x80)) break;
  }
  return [r >>> 0, pos];
}

function ef(fn: number, wt: number, val: string | number | Buffer): Buffer {
  const tag = encodeVarint((fn << 3) | wt);
  if (wt === 0) return Buffer.concat([tag, encodeVarint(val as number)]);
  if (wt === 2) {
    const d = typeof val === "string" ? Buffer.from(val, "utf8") : val as Buffer;
    return Buffer.concat([tag, encodeVarint(d.length), d]);
  }
  return tag;
}

function em(fn: number, buf: Buffer): Buffer { return ef(fn, 2, buf); }

function frame(data: Buffer, flags = 0): Buffer {
  const e = Buffer.alloc(5 + data.length);
  e[0] = flags;
  e.writeUInt32BE(data.length, 1);
  data.copy(e, 5);
  return e;
}

interface PbField { f: number; v?: number; d?: Buffer; }

function pb(buf: Buffer): PbField[] {
  const fields: PbField[] = []; let p = 0;
  while (p < buf.length) {
    let r = 0, s = 0, q = p;
    while (q < buf.length) { const b = buf[q]; r |= (b & 0x7f) << s; s += 7; q++; if (!(b & 0x80)) break; }
    if (q === p) break; p = q;
    const fn = r >> 3, wt = r & 7;
    if (wt === 0) {
      let v = 0; s = 0;
      while (p < buf.length) { const b = buf[p]; v |= (b & 0x7f) << s; s += 7; p++; if (!(b & 0x80)) break; }
      fields.push({ f: fn, v });
    } else if (wt === 2) {
      let l = 0; s = 0;
      while (p < buf.length) { const b = buf[p]; l |= (b & 0x7f) << s; s += 7; p++; if (!(b & 0x80)) break; }
      if (p + l > buf.length) break;
      fields.push({ f: fn, d: buf.subarray(p, p + l) }); p += l;
    } else if (wt === 5) p += 4;
    else if (wt === 1) p += 8;
    else break;
  }
  return fields;
}

// ─── Auth & Version ───

let _token: string | null = null;
let _clientVersion: string | null = null;

function getToken(): string {
  if (_token) return _token;
  _token = execSync(
    'security find-generic-password -s "cursor-access-token" -a "cursor-user" -w',
    { encoding: "utf8" },
  ).trim();
  return _token;
}

export function clearTokenCache(): void { _token = null; }

function getClientVersion(): string {
  if (_clientVersion) return _clientVersion;
  const base = `${process.env.HOME}/.local/share/cursor-agent/versions/`;
  try {
    const vers = fs.readdirSync(base).sort();
    if (vers.length > 0) {
      _clientVersion = `cli-${vers[vers.length - 1]}`;
      return _clientVersion;
    }
  } catch {}
  _clientVersion = "cli-unknown";
  return _clientVersion;
}

function getAgentBin(): { node: string; index: string; version: string } {
  const base = `${process.env.HOME}/.local/share/cursor-agent/versions/`;
  const vers = fs.readdirSync(base).sort();
  const latest = vers[vers.length - 1];
  const dir = path.join(base, latest);
  return { node: path.join(dir, "node"), index: path.join(dir, "index.js"), version: latest };
}

// ─── Context Capture ───

let _cachedContext: Buffer | null = null;
let _contextCapturePromise: Promise<Buffer> | null = null;

const CONTEXT_CACHE_PATH = "/tmp/cursor-proxy-context.bin";

/**
 * Capture context envelope by intercepting a CLI request.
 * Runs `agent --print "init"` with an HTTP/2 intercept hook.
 */
export async function captureContext(force = false): Promise<Buffer> {
  // Return cached
  if (_cachedContext && !force) return _cachedContext;

  // Check disk cache (survives restarts)
  if (!force && fs.existsSync(CONTEXT_CACHE_PATH)) {
    const stat = fs.statSync(CONTEXT_CACHE_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 3600_000) { // 1 hour
      _cachedContext = fs.readFileSync(CONTEXT_CACHE_PATH);
      console.log(`[direct] Loaded cached context (${_cachedContext.length} bytes, ${Math.round(ageMs / 1000)}s old)`);
      return _cachedContext;
    }
  }

  // Deduplicate concurrent captures
  if (_contextCapturePromise && !force) return _contextCapturePromise;

  _contextCapturePromise = _doCaptureContext();
  try {
    _cachedContext = await _contextCapturePromise;
    return _cachedContext;
  } finally {
    _contextCapturePromise = null;
  }
}

async function _doCaptureContext(): Promise<Buffer> {
  console.log("[direct] Capturing context from CLI...");
  const { node, index, version } = getAgentBin();

  // Write intercept script
  const interceptPath = "/tmp/cursor-ctx-intercept.mjs";
  const outPath = "/tmp/cursor-ctx-capture.bin";
  fs.writeFileSync(interceptPath, `
import http2 from 'node:http2';
import fs from 'node:fs';
const origConnect = http2.connect;
http2.connect = function(...args) {
  const session = origConnect.apply(this, args);
  const origReq = session.request;
  session.request = function(headers, ...rArgs) {
    const stream = origReq.apply(this, [headers, ...rArgs]);
    const p = headers?.[':path'] || '';
    if (p.includes('Agent')) {
      const chunks = [];
      let flushed = false;
      const flush = () => {
        if (flushed) return;
        flushed = true;
        const full = Buffer.concat(chunks);
        if (full.length > 0) fs.writeFileSync('${outPath}', full);
      };
      const origWrite = stream.write;
      stream.write = function(chunk, ...wArgs) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (!flushed && chunks.length >= 7) flush();
        return origWrite.apply(this, [chunk, ...wArgs]);
      };
      const origEnd = stream.end;
      stream.end = function(chunk, ...eArgs) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        flush();
        return origEnd.apply(this, [chunk, ...eArgs]);
      };
    }
    return stream;
  };
  return session;
};
`);

  // Clean up previous capture
  try { fs.unlinkSync(outPath); } catch {}

  return new Promise<Buffer>((resolve, reject) => {
    const env = {
      ...process.env,
      CURSOR_INVOKED_AS: "agent",
      NODE_OPTIONS: `--import ${interceptPath}`,
    };

    const child = spawn(node, ["--use-system-ca", index, "--print", "--trust", "--model", "claude-opus-4-7-high", "say hi"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    });

    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.stdout?.on("data", () => {}); // drain

    // Poll for capture file (intercept flushes after 2s delay)
    const pollInterval = setInterval(() => {
      if (fs.existsSync(outPath)) {
        clearInterval(pollInterval);
        clearTimeout(hardTimer);
        // Give a moment for final writes
        setTimeout(() => {
          child.kill("SIGTERM");
        }, 500);
      }
    }, 500);

    const hardTimer = setTimeout(() => {
      clearInterval(pollInterval);
      child.kill("SIGTERM");
    }, 25_000);

    child.on("close", () => {
      clearInterval(pollInterval);
      clearTimeout(hardTimer);
      if (!fs.existsSync(outPath)) {
        reject(new Error(`Context capture failed: no output. stderr: ${stderr.slice(0, 500)}`));
        return;
      }

      const raw = fs.readFileSync(outPath);
      const envs = parseEnvelopes(raw);
      if (envs.length < 2) {
        reject(new Error(`Context capture: only ${envs.length} envelopes`));
        return;
      }

      const contextEnv = envs[1];
      const statusEnvs = envs.slice(2);

      const packed = Buffer.concat([
        frame(contextEnv.data, contextEnv.flags),
        ...statusEnvs.map(e => frame(e.data, e.flags)),
      ]);

      fs.writeFileSync(CONTEXT_CACHE_PATH, packed);
      console.log(`[direct] Context captured: ${packed.length} bytes (${envs.length} envelopes)`);

      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(interceptPath); } catch {}

      resolve(packed);
    });

    child.on("error", (err) => {
      clearInterval(pollInterval);
      clearTimeout(hardTimer);
      reject(err);
    });
  });
}

interface Envelope { flags: number; data: Buffer; }

function parseEnvelopes(buf: Buffer): Envelope[] {
  const envs: Envelope[] = [];
  let off = 0;
  while (off + 5 <= buf.length) {
    const flags = buf[off];
    const len = buf.readUInt32BE(off + 1);
    if (off + 5 + len > buf.length) break;
    envs.push({ flags, data: buf.subarray(off + 5, off + 5 + len) });
    off += 5 + len;
  }
  return envs;
}

// ─── Request Building ───

const MODEL_DISPLAY: Record<string, string> = {
  "claude-opus-4-7-high": "Opus 4.7 1M High",
  "claude-opus-4-7-thinking-max": "Opus 4.7 1M Max",
  "claude-4.6-sonnet-medium-thinking": "Sonnet 4.6 Medium",
};

export interface DirectMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

function buildEnvelope1(messages: DirectMessage[], modelName: string): Buffer {
  const requestId = crypto.randomUUID();
  const displayName = MODEL_DISPLAY[modelName] || modelName;

  // Convert each message to protobuf format
  const msgBuffers: Buffer[] = [];
  for (const m of messages) {
    const roleVal = m.role === "user" || m.role === "system" ? 2 : 1; // HUMAN=2, AI=1
    const msg = Buffer.concat([
      ef(1, 2, m.content),
      ef(2, 2, crypto.randomUUID()),
      ef(3, 2, ""),
      ef(4, 0, roleVal),
    ]);
    msgBuffers.push(em(1, msg)); // repeated field 1 inside messages wrapper
  }

  const conversationWrapper = em(1, Buffer.concat(msgBuffers));

  const runReq = Buffer.concat([
    ef(1, 2, ""),                          // workspace
    em(2, conversationWrapper),            // conversation
    em(3, Buffer.concat([                  // model info
      ef(1, 2, modelName),
      ef(3, 2, modelName),
      ef(4, 2, displayName),
      ef(5, 2, displayName),
      ef(7, 0, 0),
    ])),
    ef(4, 2, ""),                          // empty
    ef(5, 2, requestId),                   // request_id
    ef(12, 0, 0),
    ef(16, 2, requestId),                  // same request_id
  ]);

  return frame(em(1, runReq));
}

// ─── Streaming Client ───

export interface DirectStreamCallbacks {
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

export async function streamDirect(
  messages: DirectMessage[],
  modelName: string,
  callbacks: DirectStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  // Ensure context is available
  let context: Buffer;
  try {
    context = await captureContext();
  } catch (err) {
    logError("direct/context", err instanceof Error ? err : new Error(String(err)), { model: modelName });
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  const token = getToken();
  const requestId = crypto.randomUUID();

  const envelope1 = buildEnvelope1(messages, modelName);
  const body = Buffer.concat([envelope1, context]);

  const session = http2.connect("https://agentn.global.api5.cursor.sh");
  session.on("error", (err) => {
    logError("direct/session", err, { model: modelName, requestId });
    callbacks.onError(err);
  });

  const req = session.request({
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "authorization": `Bearer ${token}`,
    "connect-accept-encoding": "gzip,br",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": getClientVersion(),
    "x-ghost-mode": "true",
    "x-request-id": requestId,
  });

  let respBuf = Buffer.alloc(0);
  let done = false;
  let lastTextTime = 0;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  function finish(err?: Error) {
    if (done) return;
    done = true;
    if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    try { req.close(); } catch {}
    try { session.close(); } catch {}
    if (err) callbacks.onError(err);
    else callbacks.onDone();
  }

  // Abort support
  if (signal) {
    if (signal.aborted) { logEvent("direct/abort", { model: modelName, requestId, reason: "pre-aborted" }); finish(new Error("Aborted")); return; }
    signal.addEventListener("abort", () => { logEvent("direct/abort", { model: modelName, requestId, reason: "client-disconnect" }); finish(new Error("Aborted")); }, { once: true });
  }

  function processEnvelopes() {
    while (respBuf.length >= 5) {
      const len = respBuf.readUInt32BE(1);
      if (respBuf.length < 5 + len) break;
      const flags = respBuf[0];
      let payload = respBuf.subarray(5, 5 + len);
      respBuf = respBuf.subarray(5 + len);

      // Trailer (flags & 2)
      if (flags & 2) {
        const trailer = payload.toString("utf8");
        if (trailer.includes('"error"')) {
          logError("direct/trailer", new Error(trailer), { model: modelName, requestId });
          finish(new Error(trailer));
        } else {
          finish();
        }
        return;
      }

      // Decompress gzip
      if (flags & 1) {
        try { payload = zlib.gunzipSync(payload); } catch { continue; }
      }

      // Extract thinking: f1 > f4 > f1 (thinking delta)
      const thinking = extractThinking(payload);
      if (thinking) {
        lastTextTime = Date.now();
        callbacks.onThinking?.(thinking);
      }

      // Extract text: f1 > f1 > f1 (text delta)
      const text = extractText(payload);
      if (text) {
        lastTextTime = Date.now();
        callbacks.onText(text);
      }
    }
  }

  function extractThinking(payload: Buffer): string | null {
    try {
      const f1 = pb(payload).find(x => x.f === 1 && x.d);
      if (!f1?.d) return null;
      const f4 = pb(f1.d).find(x => x.f === 4 && x.d);
      if (!f4?.d) return null;
      const f4f1 = pb(f4.d).find(x => x.f === 1 && x.d);
      if (!f4f1?.d) return null;
      const s = f4f1.d.toString("utf8");
      return s.length > 0 ? s : null;
    } catch { return null; }
  }

  function extractText(payload: Buffer): string | null {
    try {
      const f1 = pb(payload).find(x => x.f === 1 && x.d);
      if (!f1?.d) return null;
      const f1i = pb(f1.d).find(x => x.f === 1 && x.d);
      if (!f1i?.d) return null;
      const f1ii = pb(f1i.d).find(x => x.f === 1 && x.d);
      if (!f1ii?.d) return null;
      const s = f1ii.d.toString("utf8");
      return (s.length > 0 && /[a-zA-Z0-9]/.test(s)) ? s : null;
    } catch { return null; }
  }

  req.on("data", (chunk: Buffer) => {
    if (done) return;
    respBuf = Buffer.concat([respBuf, chunk]);
    processEnvelopes();
  });

  req.on("end", () => { if (!done) finish(); });
  req.on("error", (err) => { if (!done) finish(err); });

  // Send request
  req.end(body);

  // BiDi stream: server won't close, detect completion by idle after text
  idleTimer = setInterval(() => {
    if (lastTextTime > 0 && Date.now() - lastTextTime > 3000) {
      finish();
    }
  }, 500);

  // Hard timeout
  setTimeout(() => { if (!done) { logError("direct/timeout", new Error("Timeout (120s)"), { model: modelName, requestId }); finish(new Error("Timeout (120s)")); } }, 120_000);
}

// ─── Status ───

export function isContextCached(): boolean {
  return _cachedContext !== null || fs.existsSync(CONTEXT_CACHE_PATH);
}
