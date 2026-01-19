import { DurableObject } from "cloudflare:workers";

const TTL_MS = 15 * 60 * 1000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const KEY_PREFIX = "clips/";

function isSixDigits(x) {
  return typeof x === "string" && /^[0-9]{6}$/.test(x);
}

function noStore(extra = {}) {
  return {
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    ...extra,
  };
}

function securityHeaders(extra = {}) {
  return {
    ...noStore(extra),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
}

const INDEX_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' blob: data:",
  "connect-src 'self' ws: wss:",
  "font-src https://fonts.gstatic.com data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
].join("; ");

function json(obj, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(securityHeaders())) headers.set(k, v);
  return new Response(JSON.stringify(obj), { ...init, headers });
}

function err(status, message) {
  return json({ ok: false, error: message }, { status });
}

function ok(data = {}) {
  return json({ ok: true, ...data });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(INDEX_HTML, {
        headers: securityHeaders({
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": INDEX_CSP,
        }),
      });
    }

    if (url.pathname === "/ws") {
      const user = url.searchParams.get("user") || "";
      const device = url.searchParams.get("device") || "unknown";

      if (!isSixDigits(user)) return err(400, "Invalid user id (need 6 digits).");
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return err(426, "Expected WebSocket Upgrade.");
      }

      const id = env.MAILBOX.idFromName(user);
      const stub = env.MAILBOX.get(id);

      const nextUrl = new URL("https://do/ws");
      nextUrl.searchParams.set("device", device);

      return stub.fetch(new Request(nextUrl.toString(), request));
    }

    if (url.pathname === "/api/clip/send" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return err(400, "Invalid JSON.");

      const receiverId = body.receiverId || "";
      const clip = body.clip;

      if (!isSixDigits(receiverId)) return err(400, "receiverId must be 6 digits.");
      if (!clip || typeof clip !== "object") return err(400, "Missing clip payload.");

      const id = env.MAILBOX.idFromName(receiverId);
      const stub = env.MAILBOX.get(id);

      return stub.fetch("https://do/clip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clip }),
      });
    }

    if (url.pathname === "/api/clip/delete" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return err(400, "Invalid JSON.");

      const receiverId = body.receiverId || "";
      const clipId = body.clipId || "";

      if (!isSixDigits(receiverId)) return err(400, "receiverId must be 6 digits.");
      if (typeof clipId !== "string" || clipId.length < 8) return err(400, "Invalid clipId.");

      const id = env.MAILBOX.idFromName(receiverId);
      const stub = env.MAILBOX.get(id);

      return stub.fetch("https://do/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clipId }),
      });
    }

    if (url.pathname.startsWith("/api/r2/")) {
      const rawKey = url.pathname.slice("/api/r2/".length);
      const key = decodeURIComponent(rawKey);

      if (!key.startsWith(KEY_PREFIX)) return err(403, "Key prefix not allowed.");
      if (key.includes("..")) return err(400, "Invalid key.");

      if (request.method === "PUT") {
        const len = Number(request.headers.get("content-length") || "0");
        if (!len) return err(411, "content-length required.");
        if (len > MAX_UPLOAD_BYTES) return err(413, `Max upload is ${MAX_UPLOAD_BYTES} bytes.`);

        await env.CLIP_BUCKET.put(key, request.body, {
          httpMetadata: { contentType: "application/octet-stream", cacheControl: "no-store" },
        });

        return ok({ key });
      }

      if (request.method === "GET") {
        const obj = await env.CLIP_BUCKET.get(key);
        if (!obj) return err(404, "Not found.");

        const headers = new Headers(securityHeaders());
        headers.set("content-type", "application/octet-stream");
        headers.set("content-length", String(obj.size));
        headers.set("content-disposition", 'attachment; filename="download.bin"');
        return new Response(obj.body, { headers });
      }

      return err(405, "Method not allowed.");
    }

    return err(404, "Not found.");
  },
};

export class MailboxDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.latest = null;
    this.pending = [];

    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
      this.pending = (await this.ctx.storage.get("pending")) || [];
      if (!Array.isArray(this.pending)) this.pending = [];
      this.pending = this.pending
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          clipId: typeof x.clipId === "string" ? x.clipId : "",
          expiresAt: Number.isFinite(x.expiresAt) ? x.expiresAt : Number(x.expiresAt) || 0,
          keys: Array.isArray(x.keys) ? x.keys.filter((k) => typeof k === "string") : [],
        }))
        .filter((x) => x.clipId && x.expiresAt > 0 && x.keys.length);

      await this._cleanupIfExpired();
    });
  }

  async fetch(request) {
    await this.ready;

    const url = new URL(request.url);
    if (url.pathname === "/ws") return this._handleWS(request);
    if (url.pathname === "/clip" && request.method === "POST") return this._handleClip(request);
    if (url.pathname === "/delete" && request.method === "POST") return this._handleDelete(request);
    if (url.pathname === "/get") return ok({ latest: this.latest || null });

    return err(404, "DO: not found.");
  }

  async alarm() {
    await this.ready;
    await this._cleanupIfExpired(true);
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    try {
      const text =
        typeof message === "string" ? message : new TextDecoder().decode(new Uint8Array(message));
      const msg = JSON.parse(text);
      if (msg?.type === "ping") ws.send(JSON.stringify({ type: "pong", now: Date.now() }));
    } catch {}
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws, error) {}

  _validR2Key(k) {
    return typeof k === "string" && k.startsWith(KEY_PREFIX) && !k.includes("..") && k.length < 512;
  }

  _collectKeysFromClip(clip) {
    const out = [];
    const parts = clip?.parts || [];
    for (const p of parts) {
      const k = p?.r2Key;
      if (this._validR2Key(k)) out.push(k);
    }
    return [...new Set(out)];
  }

  async _deleteR2Keys(keys) {
    const safe = (keys || []).filter((k) => this._validR2Key(k));
    if (!safe.length) return;
    await Promise.allSettled(safe.map((k) => this.env.CLIP_BUCKET.delete(k)));
  }

  _nextAlarmAt() {
    const times = [];
    if (this.latest?.expiresAt) times.push(this.latest.expiresAt);
    for (const x of this.pending) {
      if (x?.expiresAt) times.push(x.expiresAt);
    }
    if (!times.length) return null;
    return Math.min(...times);
  }

  async _syncAlarm() {
    const next = this._nextAlarmAt();
    if (next) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async _handleWS(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return err(426, "Expected WebSocket Upgrade.");
    }

    const url = new URL(request.url);
    const deviceId = url.searchParams.get("device") || crypto.randomUUID();
    const tag = `device:${deviceId}`;

    const old = this.ctx.getWebSockets(tag);
    for (const ws of old) {
      try {
        ws.close(1000, "replaced");
      } catch {}
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [tag]);
    try {
      server.serializeAttachment({ deviceId });
    } catch {}

    server.send(JSON.stringify({ type: "hello", deviceId, now: Date.now() }));

    await this._cleanupIfExpired();
    if (this.latest) {
      server.send(JSON.stringify({ type: "clip", clip: this.latest.clip, expiresAt: this.latest.expiresAt }));
    } else {
      server.send(JSON.stringify({ type: "idle" }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async _handleClip(request) {
    const body = await request.json().catch(() => null);
    if (!body?.clip) return err(400, "Missing clip.");

    const clip = body.clip;

    if (typeof clip.id !== "string" || clip.id.length < 8) return err(400, "Invalid clip.id");
    if (typeof clip.ts !== "number") clip.ts = Date.now();
    if (!Array.isArray(clip.parts)) clip.parts = [];

    clip.parts = clip.parts
      .filter((p) => p && typeof p === "object")
      .map((p) => {
        const kind = p.kind === "image" ? "image" : "message";
        const r2Key = typeof p.r2Key === "string" ? p.r2Key : "";
        const sizeNum = Number.isFinite(p.size) ? p.size : Number(p.size) || 0;

        const mime =
          typeof p.mime === "string"
            ? p.mime
            : kind === "image"
              ? "image/*"
              : "text/plain; charset=utf-8";

        const filename = typeof p.filename === "string" ? p.filename : undefined;

        const enc =
          p.enc && typeof p.enc === "object" && typeof p.enc.ivB64 === "string"
            ? { ivB64: p.enc.ivB64 }
            : null;

        const out = { kind, r2Key, mime, size: sizeNum, enc };
        if (filename) out.filename = filename;
        return out;
      })
      .filter((p) => {
        return (
          typeof p.r2Key === "string" &&
          p.r2Key.startsWith(KEY_PREFIX) &&
          !p.r2Key.includes("..") &&
          p.r2Key.length < 512
        );
      });

    for (const p of clip.parts) {
      if (p.kind === "image" && typeof p.mime === "string") {
        if (p.mime.toLowerCase().includes("image/svg+xml")) return err(400, "SVG images are not allowed.");
      }
    }

    return await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();

      const prev = this.latest;
      if (prev?.clip?.id && prev?.expiresAt) {
        const keys = this._collectKeysFromClip(prev.clip);
        if (keys.length) {
          if (prev.expiresAt <= now) {
            await this._deleteR2Keys(keys);
          } else {
            this.pending.push({ clipId: prev.clip.id, expiresAt: prev.expiresAt, keys });
            await this.ctx.storage.put("pending", this.pending);
          }
        }
      }

      const expiresAt = now + TTL_MS;
      this.latest = { clip, expiresAt };

      await this.ctx.storage.put("latest", this.latest);
      await this._syncAlarm();

      this._broadcast({ type: "clip", clip, expiresAt });

      return ok({ stored: true, expiresAt });
    });
  }

  async _handleDelete(request) {
    const body = await request.json().catch(() => null);
    const clipId = body?.clipId;
    if (typeof clipId !== "string") return err(400, "Missing clipId.");

    if (!this.latest || this.latest.clip?.id !== clipId) {
      return ok({ deleted: false, reason: "no-match" });
    }

    await this._deleteLatest("manual");
    await this._syncAlarm();
    return ok({ deleted: true });
  }

  async _cleanupIfExpired(fromAlarm = false) {
    const now = Date.now();

    if (this.pending?.length) {
      const due = [];
      const keep = [];
      for (const x of this.pending) {
        if (x?.expiresAt && x.expiresAt <= now) due.push(x);
        else keep.push(x);
      }
      if (due.length) {
        const keys = due.flatMap((x) => x.keys || []);
        await this._deleteR2Keys(keys);
        this.pending = keep;
        await this.ctx.storage.put("pending", this.pending);
      }
    }

    if (this.latest?.expiresAt && this.latest.expiresAt <= now) {
      await this._deleteLatest(fromAlarm ? "ttl-alarm" : "ttl");
    }

    await this._syncAlarm();
  }

  async _deleteLatest(reason) {
    const latest = this.latest;
    this.latest = null;

    await this.ctx.storage.delete("latest");

    const keys = this._collectKeysFromClip(latest?.clip);
    await this._deleteR2Keys(keys);

    this._broadcast({ type: "deleted", clipId: latest?.clip?.id, reason });
  }

  _broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {}
    }
  }
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Net Clipboard</title>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@300;400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { darkMode: 'class' }
  </script>
  <style>
    :root{
      --md-primary:#6750a4;
      --md-on-primary:#ffffff;
      --md-surface:#fffbff;
      --md-on-surface:#1c1b1f;
      --md-surface-2:#f3edf7;
      --md-outline:#79747e;
      --md-error:#b3261e;
      --md-shadow: rgba(0,0,0,.12);
    }
    .dark{
      --md-primary:#d0bcff;
      --md-on-primary:#381e72;
      --md-surface:#141218;
      --md-on-surface:#e6e0e9;
      --md-surface-2:#1d1b20;
      --md-outline:#938f99;
      --md-error:#f2b8b5;
      --md-shadow: rgba(0,0,0,.45);
    }
    .ms{ font-family: "Material Symbols Outlined"; font-variation-settings: 'wght' 400; }
  </style>
</head>

<body class="min-h-screen bg-[color:var(--md-surface)] text-[color:var(--md-on-surface)]">
  <div class="max-w-md mx-auto min-h-screen flex flex-col px-4 pt-4 pb-6">

    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <span class="ms text-3xl">account_circle</span>
        <div class="flex flex-col leading-tight">
          <div class="text-xs opacity-70">寄件人代碼</div>
          <div class="flex items-center gap-2">
            <input id="userId"
              class="w-28 text-lg font-semibold bg-transparent border-b border-[color:var(--md-outline)] focus:outline-none"
              inputmode="numeric" maxlength="6" />
            <button id="userIdAction"
              class="h-9 w-9 rounded-full grid place-items-center border border-[color:var(--md-outline)] hover:opacity-80"
              title="refresh / done">
              <span id="userIdIcon" class="ms">refresh</span>
            </button>
          </div>
        </div>
      </div>

      <button id="themeBtn"
        class="h-10 w-10 rounded-full grid place-items-center border border-[color:var(--md-outline)] hover:opacity-80"
        title="深色/淺色">
        <span id="themeIcon" class="ms">dark_mode</span>
      </button>
    </div>

    <div class="mt-3 text-sm">
      <div class="flex items-center gap-2">
        <span id="connDot" class="inline-block w-2.5 h-2.5 rounded-full bg-[color:var(--md-outline)]"></span>
        <span id="connText" class="opacity-80">尚未連線</span>
      </div>
    </div>

    <div class="mt-4 flex-1">
      <div class="rounded-3xl p-4 bg-[color:var(--md-surface-2)] shadow-[0_6px_24px_var(--md-shadow)]">
        <div id="sendView" class="">
          <div class="flex items-center gap-2 mb-3">
            <span class="ms">send</span>
            <div class="font-semibold">傳送</div>
          </div>

          <label class="block text-sm opacity-80 mb-1">收件人代碼（必填）</label>
          <input id="receiverId"
            class="w-full rounded-2xl px-3 py-2 bg-[color:var(--md-surface)] border border-[color:var(--md-outline)] focus:outline-none"
            inputmode="numeric" maxlength="6" placeholder="例如 123456" />

          <label class="block text-sm opacity-80 mt-3 mb-1">取件口令（選填）</label>
          <input id="accessToken"
            class="w-full rounded-2xl px-3 py-2 bg-[color:var(--md-surface)] border border-[color:var(--md-outline)] focus:outline-none"
            placeholder="建議：OTP/敏感內容請務必填" />

          <label class="block text-sm opacity-80 mt-3 mb-1">文字留言板（選填）</label>
          <textarea id="mailboxMessage" rows="4"
            class="w-full rounded-2xl px-3 py-2 bg-[color:var(--md-surface)] border border-[color:var(--md-outline)] focus:outline-none"
            placeholder="長文字/多行內容…（可加密）"></textarea>

          <label class="block text-sm opacity-80 mt-3 mb-1">寄送圖片（選填）</label>
          <input id="imageFile" type="file" accept="image/*"
            class="w-full text-sm file:mr-4 file:rounded-full file:border-0 file:px-4 file:py-2
                   file:bg-[color:var(--md-primary)] file:text-[color:var(--md-on-primary)]" />

          <div class="mt-4 flex gap-2">
            <button id="sendBtn"
              class="flex-1 rounded-full px-4 py-3 bg-[color:var(--md-primary)] text-[color:var(--md-on-primary)] font-semibold hover:opacity-90">
              送出
            </button>
            <button id="clearBtn"
              class="rounded-full px-4 py-3 border border-[color:var(--md-outline)] hover:opacity-80">
              清空
            </button>
          </div>

          <div id="sendHint" class="mt-3 text-sm opacity-80"></div>

          <div id="sentCard" class="mt-4 hidden">
            <div class="rounded-2xl p-3 bg-[color:var(--md-surface)] border border-[color:var(--md-outline)]">
              <div class="text-sm opacity-80">最近一次送出的 clip</div>
              <div class="mt-1 font-mono text-xs break-all" id="sentInfo"></div>
              <div class="mt-3 flex gap-2">
                <button id="revokeBtn"
                  class="rounded-full px-4 py-2 border border-[color:var(--md-outline)] hover:opacity-80">
                  撤回/刪除
                </button>
              </div>
            </div>
          </div>
        </div>

        <div id="recvView" class="hidden">
          <div class="flex items-center gap-2 mb-3">
            <span class="ms">move_to_inbox</span>
            <div class="font-semibold">接收</div>
          </div>

          <div id="pendingBox" class="flex items-center gap-2 opacity-80">
            <span class="ms animate-pulse">pending</span>
            <span>等待中…（保持此頁可即時接收）</span>
          </div>

          <div id="clipBox" class="hidden mt-3">
            <div class="rounded-2xl p-3 bg-[color:var(--md-surface)] border border-[color:var(--md-outline)]">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="text-sm opacity-80">收到的 clip</div>
                  <div class="font-mono text-xs break-all mt-1" id="clipMeta"></div>
                </div>
                <button id="deleteBtn"
                  class="h-10 w-10 rounded-full grid place-items-center border border-[color:var(--md-outline)] hover:opacity-80"
                  title="刪除">
                  <span class="ms">delete</span>
                </button>
              </div>

              <div id="decryptRow" class="mt-3 hidden">
                <div class="text-sm opacity-80 mb-1">此信件已加密：輸入解密口令</div>
                <div class="flex gap-2">
                  <input id="decryptToken"
                    class="flex-1 rounded-2xl px-3 py-2 bg-[color:var(--md-surface)] border border-[color:var(--md-outline)] focus:outline-none"
                    placeholder="輸入口令，於本地處理" />
                  <button id="decryptBtn"
                    class="rounded-full px-4 py-2 bg-[color:var(--md-primary)] text-[color:var(--md-on-primary)] font-semibold hover:opacity-90">
                    解密
                  </button>
                </div>
              </div>

              <div id="partsBox" class="mt-3 grid gap-3"></div>

              <div id="recvHint" class="mt-3 text-sm opacity-80"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-4 grid grid-cols-2 gap-2">
      <button id="tabSend"
        class="rounded-2xl py-3 border border-[color:var(--md-outline)] hover:opacity-80 flex items-center justify-center gap-2">
        <span class="ms">send</span><span>傳送</span>
      </button>
      <button id="tabRecv"
        class="rounded-2xl py-3 border border-[color:var(--md-outline)] hover:opacity-80 flex items-center justify-center gap-2">
        <span class="ms">move_to_inbox</span><span>接收</span>
      </button>
    </div>

    <div class="mt-4 text-xs opacity-70 leading-relaxed">
      建議：敏感內容請填加密口令，內容會在瀏覽器端加密後才上傳，Cloudflare 看不到內容明文，但仍可看到檔名/大小/時間等中繼資料。所有文件 15 分鐘到期自動刪除，或寄件人/收件人可點選立即刪除。
    </div>

    <div class="mt-6 pt-6 border-t border-[color:var(--md-outline)] text-center text-xs opacity-60">
      <p>
        A secure, serverless cross-device temporary clipboard powered by 
        <a href="https://github.com/Naoar1/netclipboard" target="_blank" class="underline hover:opacity-100">netclipboard</a>, 
        made with <span class="text-red-500">❤</span> by 
        <a href="https://github.com/Naoar1" target="_blank" class="underline hover:opacity-100">Naoar1</a>.
      </p>
    </div>
  </div>

<script>
(function(){
  const $ = (id) => document.getElementById(id);

  const state = {
    userId: "",
    dirtyUserId: false,
    deviceId: "",
    ws: null,
    lastClip: null,
    sent: null,
    theme: "auto",
  };

  function randUserId(){
    const n = Math.floor(Math.random() * 1000000);
    return String(n).padStart(6, "0");
  }

  function loadDeviceId(){
    const k = "nc_device_id";
    let v = localStorage.getItem(k);
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v); }
    return v;
  }

  function loadUserId(){
    const k = "nc_user_id";
    let v = localStorage.getItem(k);
    if (!v || !/^\\d{6}$/.test(v)) { v = randUserId(); localStorage.setItem(k, v); }
    return v;
  }

  function setConnStatus(connected, text){
    $("connDot").style.background = connected ? "var(--md-primary)" : "var(--md-outline)";
    $("connText").textContent = text;
  }

  function setUserIdIcon(){
    $("userIdIcon").textContent = state.dirtyUserId ? "done" : "refresh";
  }

  function applyTheme(){
    const saved = localStorage.getItem("nc_theme") || "auto";
    state.theme = saved;

    const isDark = saved === "dark" || (saved === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", isDark);
    $("themeIcon").textContent = isDark ? "light_mode" : "dark_mode";
  }

  $("themeBtn").addEventListener("click", () => {
    const cur = localStorage.getItem("nc_theme") || "auto";
    const next = cur === "auto" ? "dark" : (cur === "dark" ? "light" : "auto");
    localStorage.setItem("nc_theme", next);
    applyTheme();
  });

  function wsUrl(userId, deviceId){
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/ws?user=" + encodeURIComponent(userId) + "&device=" + encodeURIComponent(deviceId);
  }

  function connectWS(){
    if (state.ws) { try { state.ws.close(); } catch {} }
    setConnStatus(false, "連線中…");

    const ws = new WebSocket(wsUrl(state.userId, state.deviceId));
    state.ws = ws;

    ws.onopen = () => setConnStatus(true, "已連線（WebSocket）");
    ws.onclose = () => setConnStatus(false, "已斷線");
    ws.onerror = () => setConnStatus(false, "連線錯誤");

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }

      if (msg.type === "clip") {
        state.lastClip = { clip: msg.clip, expiresAt: msg.expiresAt };
        renderReceived();
      } else if (msg.type === "deleted") {
        if (state.lastClip?.clip?.id === msg.clipId) {
          state.lastClip = null;
          renderReceived();
        }
        if (state.sent?.clipId === msg.clipId) {
          state.sent = null;
          renderSent();
        }
      }
    };
  }

  function showView(which){
    $("sendView").classList.toggle("hidden", which !== "send");
    $("recvView").classList.toggle("hidden", which !== "recv");

    $("tabSend").style.background = which === "send" ? "var(--md-surface-2)" : "transparent";
    $("tabRecv").style.background = which === "recv" ? "var(--md-surface-2)" : "transparent";
  }
  $("tabSend").addEventListener("click", () => showView("send"));
  $("tabRecv").addEventListener("click", () => showView("recv"));

  $("userId").addEventListener("input", () => {
    state.dirtyUserId = true;
    setUserIdIcon();
  });

  $("userIdAction").addEventListener("click", () => {
    if (state.dirtyUserId) {
      const v = $("userId").value.trim();
      if (!/^\\d{6}$/.test(v)) {
        alert("寄件人需為 6 位數字");
        return;
      }
      state.userId = v;
      localStorage.setItem("nc_user_id", v);
      state.dirtyUserId = false;
      setUserIdIcon();
      connectWS();
      return;
    }
    const v = randUserId();
    state.userId = v;
    $("userId").value = v;
    localStorage.setItem("nc_user_id", v);
    state.dirtyUserId = false;
    setUserIdIcon();
    connectWS();
  });

  function b64(u8){
    let s = "";
    u8.forEach(b => s += String.fromCharCode(b));
    return btoa(s);
  }
  function unb64(s){
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  async function deriveKey(token, saltB64, iter){
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(token),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: unb64(saltB64), iterations: iter, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptBytes(key, plainU8){
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name:"AES-GCM", iv }, key, plainU8);
    return { ivB64: b64(iv), cipherU8: new Uint8Array(ct) };
  }

  async function decryptBytes(key, ivB64, cipherU8){
    const iv = unb64(ivB64);
    const pt = await crypto.subtle.decrypt({ name:"AES-GCM", iv }, key, cipherU8);
    return new Uint8Array(pt);
  }

  async function r2Put(key, bytesU8, contentType){
    const res = await fetch("/api/r2/" + encodeURIComponent(key), {
      method: "PUT",
      headers: { "content-type": contentType, "content-length": String(bytesU8.byteLength) },
      body: bytesU8
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "upload failed");
    return j.key;
  }

  async function r2Get(key){
    const res = await fetch("/api/r2/" + encodeURIComponent(key));
    if (!res.ok) throw new Error("download failed");
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  function clearSend(){
    $("receiverId").value = "";
    $("accessToken").value = "";
    $("mailboxMessage").value = "";
    $("imageFile").value = "";
    $("sendHint").textContent = "";
  }
  $("clearBtn").addEventListener("click", clearSend);

  $("sendBtn").addEventListener("click", async () => {
    $("sendBtn").disabled = true;
    $("sendHint").textContent = "處理中…";
    try{
      const receiverId = $("receiverId").value.trim();
      if (!/^\\d{6}$/.test(receiverId)) throw new Error("收件人需為 6 位數字");

      const token = $("accessToken").value;
      const hasE2EE = token.trim().length > 0;

      const clipId = crypto.randomUUID();
      const parts = [];

      let kdf = null;
      let aesKey = null;
      if (hasE2EE){
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const saltB64 = b64(salt);
        const iter = 100000;
        aesKey = await deriveKey(token, saltB64, iter);
        kdf = { v:1, alg:"PBKDF2-AESGCM", saltB64, iter, hash:"SHA-256" };
      }

      const msg = $("mailboxMessage").value;
      if (msg && msg.trim().length){
        const enc = new TextEncoder();
        let dataU8 = enc.encode(msg);
        let ivB64 = null;

        if (hasE2EE){
          const out = await encryptBytes(aesKey, dataU8);
          dataU8 = out.cipherU8;
          ivB64 = out.ivB64;
        }

        const key = "clips/" + receiverId + "/" + clipId + "/message.bin";
        await r2Put(key, dataU8, "application/octet-stream");
        parts.push({
          kind: "message",
          r2Key: key,
          mime: "text/plain; charset=utf-8",
          size: dataU8.byteLength,
          enc: hasE2EE ? { ivB64 } : null
        });
      }

      const f = $("imageFile").files && $("imageFile").files[0];
      if (f){
        const ab = await f.arrayBuffer();
        let dataU8 = new Uint8Array(ab);
        let ivB64 = null;

        if (hasE2EE){
          const out = await encryptBytes(aesKey, dataU8);
          dataU8 = out.cipherU8;
          ivB64 = out.ivB64;
        }

        const key = "clips/" + receiverId + "/" + clipId + "/image.bin";
        await r2Put(key, dataU8, "application/octet-stream");
        parts.push({
          kind: "image",
          r2Key: key,
          mime: f.type || "image/*",
          filename: f.name || "image",
          size: dataU8.byteLength,
          enc: hasE2EE ? { ivB64 } : null
        });
      }

      if (!parts.length) throw new Error("至少要填留言板或選一張圖片");

      const clip = {
        id: clipId,
        ts: Date.now(),
        fromUser: state.userId,
        fromDevice: state.deviceId,
        enc: hasE2EE ? kdf : null,
        parts
      };

      const res = await fetch("/api/clip/send", {
        method: "POST",
        headers: { "content-type":"application/json" },
        body: JSON.stringify({ receiverId, clip })
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "send failed");

      state.sent = { receiverId, clipId };
      renderSent();

      $("sendHint").textContent = hasE2EE ? "已送出（加密）" : "已送出（未加密）";
    }catch(e){
      $("sendHint").textContent = "錯誤：" + (e && e.message ? e.message : String(e));
    }finally{
      $("sendBtn").disabled = false;
    }
  });

  async function deleteClip(receiverId, clipId){
    const res = await fetch("/api/clip/delete", {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify({ receiverId, clipId })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "delete failed");
    return j;
  }

  $("revokeBtn").addEventListener("click", async () => {
    if (!state.sent) return;
    try{
      $("sendHint").textContent = "刪除中…";
      await deleteClip(state.sent.receiverId, state.sent.clipId);
      state.sent = null;
      renderSent();
      $("sendHint").textContent = "已刪除";
    }catch(e){
      $("sendHint").textContent = "刪除失敗：" + (e?.message || e);
    }
  });

  function renderSent(){
    if (!state.sent){
      $("sentCard").classList.add("hidden");
      return;
    }
    $("sentCard").classList.remove("hidden");
    $("sentInfo").textContent = "receiver=" + state.sent.receiverId + "  clipId=" + state.sent.clipId;
  }

  function safeFilename(name, fallback) {
    const s = String(name || "")
      .replace(/[\\\\\\/]/g, "_")
      .replace(/[\\u0000-\\u001F\\u007F]/g, "_")
      .slice(0, 120);
    return s || fallback;
  }

  function renderReceived(){
    const latest = state.lastClip;
    if (!latest){
      $("pendingBox").classList.remove("hidden");
      $("clipBox").classList.add("hidden");
      return;
    }

    $("pendingBox").classList.add("hidden");
    $("clipBox").classList.remove("hidden");

    const clip = latest.clip;
    $("clipMeta").textContent =
      "clipId=" + clip.id +
      "  ts=" + new Date(clip.ts).toLocaleString() +
      "  parts=" + (clip.parts?.length || 0);

    $("recvHint").textContent = "";

    const hasEnc = !!clip.enc;
    $("decryptRow").classList.toggle("hidden", !hasEnc);

    const box = $("partsBox");
    box.innerHTML = "";

    (clip.parts || []).forEach((p, idx) => {
      const div = document.createElement("div");
      div.className = "rounded-2xl p-3 border border-[color:var(--md-outline)] bg-[color:var(--md-surface)]";

      const title = document.createElement("div");
      title.className = "flex items-center justify-between gap-2";

      const left = document.createElement("div");
      left.className = "flex items-center gap-2";

      const icon = document.createElement("span");
      icon.className = "ms";
      icon.textContent = (p.kind === "image" ? "image" : "description");

      const label = document.createElement("div");
      label.className = "font-semibold";
      label.textContent = (p.kind === "image" ? "圖片" : "文字");

      left.appendChild(icon);
      left.appendChild(label);

      const right = document.createElement("div");
      right.className = "text-xs opacity-70";
      right.textContent = String(Math.round((Number(p.size) || 0) / 1024)) + " KB";

      title.appendChild(left);
      title.appendChild(right);

      const actions = document.createElement("div");
      actions.className = "mt-2 flex flex-wrap gap-2";

      const loadBtn = document.createElement("button");
      loadBtn.className = "rounded-full px-4 py-2 bg-[color:var(--md-primary)] text-[color:var(--md-on-primary)] font-semibold hover:opacity-90";
      loadBtn.textContent = "載入";
      loadBtn.onclick = async () => {
        try{
          $("recvHint").textContent = "載入中…";
          let dataU8 = await r2Get(p.r2Key);

          if (clip.enc){
            const token = $("decryptToken").value;
            if (!token) throw new Error("需要 access_token 才能解密");
            const key = await deriveKey(token, clip.enc.saltB64, clip.enc.iter);
            dataU8 = await decryptBytes(key, p.enc.ivB64, dataU8);
          }

          if (p.kind === "message"){
            const txt = new TextDecoder().decode(dataU8);
            await navigator.clipboard.writeText(txt).catch(()=>{});
            $("recvHint").textContent = "已載入文字（已嘗試複製到剪貼簿）";
            const pre = document.createElement("pre");
            pre.className = "mt-2 whitespace-pre-wrap text-sm rounded-xl p-2 bg-[color:var(--md-surface-2)]";
            pre.textContent = txt;
            div.appendChild(pre);
          } else if (p.kind === "image"){
            const blob = new Blob([dataU8], { type: p.mime || "image/*" });
            const url = URL.createObjectURL(blob);

            const img = document.createElement("img");
            img.className = "mt-2 w-full rounded-2xl border border-[color:var(--md-outline)]";
            img.src = url;
            div.appendChild(img);

            if (window.ClipboardItem){
              try{
                await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
                $("recvHint").textContent = "已載入圖片（已嘗試複製到剪貼簿）";
              }catch{
                $("recvHint").textContent = "已載入圖片（此瀏覽器可能不支援直接複製圖片，可用下載）";
              }
            }else{
              $("recvHint").textContent = "已載入圖片（此瀏覽器可能不支援直接複製圖片，可用下載）";
            }
          }
        }catch(e){
          $("recvHint").textContent = "載入失敗：" + (e?.message || e);
        }
      };

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "rounded-full px-4 py-2 border border-[color:var(--md-outline)] hover:opacity-80";
      downloadBtn.textContent = "下載";
      downloadBtn.onclick = async () => {
        try{
          $("recvHint").textContent = "下載中…";
          let dataU8 = await r2Get(p.r2Key);

          if (clip.enc){
            const token = $("decryptToken").value;
            if (!token) throw new Error("需要口令才能解密");
            const key = await deriveKey(token, clip.enc.saltB64, clip.enc.iter);
            dataU8 = await decryptBytes(key, p.enc.ivB64, dataU8);
          }

          const blob = new Blob([dataU8], { type: (p.kind==="message") ? "text/plain;charset=utf-8" : (p.mime || "application/octet-stream") });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = (p.kind==="image") ? safeFilename(p.filename, "image") : "message.txt";
          document.body.appendChild(a);
          a.click();
          a.remove();
          $("recvHint").textContent = "已下載";
        }catch(e){
          $("recvHint").textContent = "下載失敗：" + (e?.message || e);
        }
      };

      actions.appendChild(loadBtn);
      actions.appendChild(downloadBtn);

      div.appendChild(title);
      div.appendChild(actions);
      box.appendChild(div);
    });
  }

  $("deleteBtn").addEventListener("click", async () => {
    const latest = state.lastClip;
    if (!latest) return;
    try{
      $("recvHint").textContent = "刪除中…";
      await deleteClip(state.userId, latest.clip.id);
      state.lastClip = null;
      renderReceived();
      $("recvHint").textContent = "已刪除";
    }catch(e){
      $("recvHint").textContent = "刪除失敗：" + (e?.message || e);
    }
  });

  $("decryptBtn").addEventListener("click", () => {
    $("recvHint").textContent = "已設定口令（點載入/下載會解密）";
  });

  applyTheme();

  state.deviceId = loadDeviceId();
  state.userId = loadUserId();
  $("userId").value = state.userId;
  state.dirtyUserId = false;
  setUserIdIcon();

  showView("send");
  connectWS();
  renderReceived();
})();
</script>
</body>
</html>`;
