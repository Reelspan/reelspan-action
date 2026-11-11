// src/main.ts
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// node_modules/reelspan/dist/index.js
var VERSION = "1.0.1";
var ReelspanError = class extends Error {
  status;
  code;
  body;
  /** Seconds the API asked to wait (429 and 503), when it said. */
  retryAfter;
  constructor(status, body, retryAfter = null) {
    super(typeof body.message === "string" ? body.message : `Reelspan API error ${status}`);
    this.name = "ReelspanError";
    this.status = status;
    this.code = typeof body.error_code === "string" ? body.error_code : null;
    this.body = body;
    this.retryAfter = retryAfter;
  }
  get isRateLimited() {
    return this.status === 429;
  }
};
var ReelspanConnectionError = class extends Error {
  cause;
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "ReelspanConnectionError";
  }
};
var env = (k) => globalThis.process?.env?.[k];
var sleep = (ms, signal) => new Promise((resolve2, reject) => {
  const t = setTimeout(resolve2, ms);
  signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
});
var uuid = () => typeof globalThis.crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
var enc = encodeURIComponent;
function appendFields(form, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (v === void 0 || v === null)
      continue;
    if (Array.isArray(v))
      for (const x of v)
        form.append(k.endsWith("[]") ? k : `${k}[]`, x);
    else
      form.append(k, String(v));
  }
}
function toBlob(file) {
  if (file instanceof Blob)
    return file;
  const bytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
  return new Blob([bytes], { type: file.type ?? "application/octet-stream" });
}
var nameOf = (file, fallback) => file instanceof Blob ? file.name ?? fallback : file.name;
function appendFile(form, field, file) {
  if (typeof file === "string")
    return form.append(field, file);
  form.append(field, toBlob(file), nameOf(file, field));
}
function common(p) {
  return {
    user: p.user,
    "platform[]": p.platforms,
    title: p.title,
    description: p.description,
    scheduled_date: p.scheduledDate,
    timezone: p.timezone,
    add_to_queue: p.addToQueue ? "true" : void 0,
    async_upload: p.async ? "true" : void 0,
    first_comment: p.firstComment,
    repeat_every: p.repeatEvery,
    repeat_times: p.repeatTimes,
    external_id: p.externalId,
    ...p.extra
  };
}
var postOpts = (p) => ({ idempotencyKey: p.idempotencyKey ?? uuid(), signal: p.signal });
var DIRECT_UPLOAD_BYTES = 90 * 1024 * 1024;
var Reelspan = class {
  key;
  base;
  doFetch;
  timeoutMs;
  maxRetries;
  headers;
  directUploadBytes;
  /** The rate limit reported on the last answer, if any. */
  rateLimit = null;
  constructor(opts = {}) {
    const key = opts.apiKey ?? env("REELSPAN_API_KEY");
    if (!key)
      throw new Error("Reelspan: pass apiKey or set REELSPAN_API_KEY");
    this.key = key;
    this.base = (opts.baseUrl ?? env("REELSPAN_BASE_URL") ?? "https://api.reelspan.com").replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? ((...a) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 12e4;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.headers = opts.headers ?? {};
    this.directUploadBytes = opts.directUploadBytes ?? DIRECT_UPLOAD_BYTES;
  }
  /** Any endpoint: `request('GET', '/v1/me')`. Returns the parsed JSON; throws ReelspanError on an error status. */
  async request(method, path, req = {}) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== void 0 && v !== null)
        url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    const headers = { ...this.headers, authorization: `Bearer ${this.key}`, accept: "application/json", "x-reelspan-sdk": `node/${VERSION}` };
    if (req.idempotencyKey)
      headers["idempotency-key"] = req.idempotencyKey;
    let body;
    if (req.json !== void 0) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    const safe = ["GET", "HEAD", "PUT", "DELETE"].includes(method.toUpperCase()) || !!req.idempotencyKey;
    const tries = (req.maxRetries ?? this.maxRetries) + 1;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        const timeout = AbortSignal.timeout(req.timeoutMs ?? this.timeoutMs);
        const signal = req.signal ? anySignal(req.signal, timeout) : timeout;
        res = await this.doFetch(url.toString(), { method, headers, body: req.form ?? body, signal });
      } catch (err) {
        if (req.signal?.aborted)
          throw err;
        if (safe && attempt < tries) {
          await sleep(backoff(attempt), req.signal);
          continue;
        }
        const timedOut = err?.name === "TimeoutError";
        throw new ReelspanConnectionError(timedOut ? `Reelspan: no answer within ${req.timeoutMs ?? this.timeoutMs} ms` : `Reelspan: could not reach ${this.base} (${err?.message ?? err})`, err);
      }
      this.noteRateLimit(res);
      const text = await res.text();
      let parsed = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { message: text.slice(0, 500) };
      }
      if (res.ok)
        return parsed;
      const retryAfter = Number(res.headers.get("retry-after")) || null;
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      if (retryable && (safe || res.status === 429) && attempt < tries) {
        await sleep(retryAfter ? Math.min(retryAfter, 60) * 1e3 : backoff(attempt), req.signal);
        continue;
      }
      throw new ReelspanError(res.status, parsed, retryAfter);
    }
  }
  noteRateLimit(res) {
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    if (limit)
      this.rateLimit = { limit, remaining: Number(res.headers.get("x-ratelimit-remaining")), reset: Number(res.headers.get("x-ratelimit-reset")) };
  }
  /** The key's account: plan, usage and limits. */
  me() {
    return this.request("GET", "/v1/me");
  }
  /** Every network and whether it is open, with what it takes. Needs no key scope. */
  platforms() {
    return this.request("GET", "/platforms");
  }
  profiles = {
    list: () => this.request("GET", "/v1/profiles"),
    get: (username) => this.request("GET", `/v1/profiles/${enc(username)}`),
    create: (username, displayName) => this.request("POST", "/v1/profiles", { json: { username, display_name: displayName } }),
    rename: (username, displayName) => this.request("PATCH", `/v1/profiles/${enc(username)}`, { json: { display_name: displayName } }),
    delete: (username) => this.request("DELETE", "/v1/profiles", { json: { username } }),
    /** @deprecated use `connect.link` */
    connectLink: (username, branding = {}) => this.connect.link(username, branding),
    /** @deprecated use `accounts.disconnect` */
    disconnect: (username, platform) => this.accounts.disconnect(username, platform)
  };
  /** The accounts connected to a profile. */
  accounts = {
    /**
     * Connects a network that uses credentials instead of an OAuth sign-in (Telegram, Discord, Slack, Mastodon,
     * WordPress, Dev.to, Hashnode, Bluesky). The fields are checked with the network
     * first. Upload-Post's field names work too, e.g. `{ chat_id }`, `{ instance_url, access_token }`.
     */
    connect: (username, platform, credentials) => this.request("POST", `/v1/accounts/${enc(platform)}`, { json: { profile_username: username, ...credentials } }),
    disconnect: (username, platform) => this.request("DELETE", "/v1/accounts", { json: { profile_username: username, social_platform: platform } })
  };
  /** Connecting accounts for people who have no Reelspan login (your customers). */
  connect = {
    /** A hosted, branded page where they connect networks to this profile. */
    link: (username, branding = {}) => this.request("POST", "/v1/connect-links", { json: { username, ...branding } }),
    /** Checks a connect token from a link (as your own page would). */
    validate: (token) => this.validateToken(token),
    /** Starts an OAuth connection and returns the network's authorize_url to send them to. */
    oauthStart: (platform, opts = {}) => this.request("POST", `/v1/oauth/${enc(platform)}/start`, { json: { profile: opts.profile, redirect_url: opts.redirectUrl } })
  };
  // the token, not the API key, is the credential here
  async validateToken(token) {
    const res = await this.doFetch(`${this.base}/v1/connect-links/validate`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new ReelspanError(res.status, body);
    return body;
  }
  posts = {
    /** A video file, bytes, or a public URL; or `videoMediaId` from media.upload / the library. Large files go up in parts first. */
    video: async (p) => {
      let mediaId = p.videoMediaId;
      if (!mediaId && p.video && typeof p.video !== "string" && toBlob(p.video).size >= this.directUploadBytes)
        mediaId = (await this.media.upload(p.video, { kind: "video" })).media_id;
      const form = new FormData();
      appendFields(form, { ...common(p), video_media_id: mediaId });
      if (p.video !== void 0 && !mediaId)
        appendFile(form, "video", p.video);
      if (p.thumbnail !== void 0)
        appendFile(form, typeof p.thumbnail === "string" ? "thumbnail_url" : "thumbnail", p.thumbnail);
      return this.request("POST", "/v1/posts/video", { form, ...postOpts(p) });
    },
    /** One photo or a carousel: files, bytes or public URLs, in order; or `photoMediaIds`. */
    photos: (p) => {
      const form = new FormData();
      appendFields(form, { ...common(p), "photo_media_ids[]": p.photoMediaIds, "alt_text[]": p.altTexts });
      for (const ph of p.photos ?? [])
        appendFile(form, "photos[]", ph);
      return this.request("POST", "/v1/posts/photos", { form, ...postOpts(p) });
    },
    /** Text only. Long text becomes a thread on X and Bluesky. */
    text: (p) => this.request("POST", "/v1/posts/text", {
      json: Object.fromEntries(Object.entries(common(p)).filter(([, v]) => v !== void 0).map(([k, v]) => [k === "platform[]" ? "platform" : k, v])),
      ...postOpts(p)
    }),
    /** A PDF to LinkedIn, shown as a swipeable document. */
    document: (p) => {
      const form = new FormData();
      appendFields(form, { ...common(p), document_media_id: p.documentMediaId });
      if (p.document !== void 0)
        appendFile(form, "document", p.document);
      return this.request("POST", "/v1/posts/document", { form, ...postOpts(p) });
    },
    /** Each network's result for a request_id (or a scheduled job_id). */
    status: (id) => this.request("GET", "/v1/posts/status", { query: { request_id: id.requestId, job_id: id.jobId } }),
    /** Polls status until every network has finished (or the timeout passes). */
    /** Polls status (every 5 s by default, the API's advice) until every network has finished, or the timeout passes. */
    wait: async (requestId, opts = {}) => {
      const end = Date.now() + (opts.timeoutMs ?? 6e5);
      for (; ; ) {
        const s = await this.request("GET", "/v1/posts/status", { query: { request_id: requestId }, signal: opts.signal });
        if (["completed", "failed", "cancelled"].includes(s.status) || Date.now() > end)
          return s;
        await sleep(opts.intervalMs ?? 5e3, opts.signal);
      }
    },
    /**
     * Sends the failed networks again, with the media it already has. `fields` changes settings for this try (e.g. a
     * new caption). Not repeated automatically on a network error: the server can't tell a repeat from a new retry.
     */
    retry: (requestId, opts = {}) => {
      const o = Array.isArray(opts) ? { platforms: opts } : opts;
      return this.request("POST", "/v1/posts/retry", { json: { request_id: requestId, job_id: o.jobId, platforms: o.platforms, fields: o.fields } });
    },
    /** One page of history, one row per network post. */
    history: (query = {}) => this.request("GET", "/v1/posts", { query }),
    /** Every history row, page by page: `for await (const row of reelspan.posts.all({ platform: 'tiktok' }))`. */
    all: (query = {}) => this.historyRows(query)
  };
  async *historyRows(query) {
    for (let page = 1; ; page++) {
      const r = await this.posts.history({ ...query, limit: 100, page });
      yield* r.history;
      if (page * r.limit >= r.total || !r.history.length)
        return;
    }
  }
  scheduled = {
    list: (query = {}) => this.request("GET", "/v1/scheduled", { query }),
    get: (jobId) => this.request("GET", `/v1/scheduled/${enc(jobId)}`),
    edit: (jobId, patch) => this.request("PATCH", `/v1/scheduled/${enc(jobId)}`, { json: patch }),
    /** `withLaterRepeats` also cancels the later posts of a repeating series. */
    cancel: (jobId, opts = {}) => this.request("DELETE", `/v1/scheduled/${enc(jobId)}`, { query: { series: opts.withLaterRepeats ? "rest" : void 0 } })
  };
  queue = {
    settings: (username) => this.request("GET", "/v1/queue/settings", { query: { profile_username: username } }),
    setSettings: (username, settings) => this.request("POST", "/v1/queue/settings", { json: { profile_username: username, ...settings } }),
    preview: (username, count) => this.request("GET", "/v1/queue/preview", { query: { profile_username: username, count } }),
    nextSlot: (username) => this.request("GET", "/v1/queue/next-slot", { query: { profile_username: username } }),
    /** Keeps the queue from using this slot (ISO-8601 with an offset). */
    markFull: (username, slot) => this.request("POST", "/v1/queue/slot-full", { json: { profile_username: username, slot_datetime: slot } }),
    markOpen: (username, slot) => this.request("DELETE", "/v1/queue/slot-full", { json: { profile_username: username, slot_datetime: slot } })
  };
  media = {
    /**
     * Uploads a file once and returns its media_id, to post or keep in the library. Files from 90 MB go straight to
     * storage in parts (with retries per part), up to your plan's limit; smaller ones in one request.
     */
    upload: async (file, opts = {}) => {
      const blob = toBlob(file);
      if (blob.size < this.directUploadBytes) {
        const form = new FormData();
        form.append("file", blob, nameOf(file, "file"));
        const r2 = await this.request("POST", "/v1/media/upload", { form, query: { kind: opts.kind, save: opts.save ? "true" : void 0, title: opts.title } });
        opts.onProgress?.(blob.size, blob.size);
        return r2;
      }
      const r = await this.uploadInParts(blob, nameOf(file, "file"), opts.kind ?? "video", opts.onProgress);
      if (opts.save)
        await this.library.keep([r.media_id], opts.title);
      return r;
    }
  };
  async uploadInParts(blob, filename, kind, onProgress) {
    const start = await this.request("POST", "/v1/media/uploads", { json: { kind, size_bytes: blob.size, filename } });
    const done = [];
    let sent = 0;
    try {
      const queue = [...start.parts];
      const worker = async () => {
        for (let part = queue.shift(); part; part = queue.shift()) {
          const chunk = blob.slice((part.part_number - 1) * start.part_size, part.part_number * start.part_size);
          for (let attempt = 1; ; attempt++) {
            try {
              const res = await this.doFetch(part.url, { method: "PUT", body: chunk, signal: AbortSignal.timeout(this.timeoutMs) });
              const etag = res.headers.get("etag");
              if (!res.ok || !etag)
                throw new Error(`storage answered ${res.status}`);
              done.push({ part_number: part.part_number, etag });
              sent += chunk.size;
              onProgress?.(sent, blob.size);
              break;
            } catch (err) {
              if (attempt > this.maxRetries + 1)
                throw new ReelspanConnectionError(`Reelspan: part ${part.part_number} of the upload failed (${err.message})`, err);
              await sleep(backoff(attempt));
            }
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      return await this.request("POST", `/v1/media/uploads/${enc(start.media_id)}/complete`, { json: { parts: done.sort((a, b) => a.part_number - b.part_number) } });
    } catch (err) {
      await this.request("POST", `/v1/media/uploads/${enc(start.media_id)}/abort`, { maxRetries: 0 }).catch(() => void 0);
      throw err;
    }
  }
  library = {
    list: (query = {}) => this.request("GET", "/v1/library", { query }),
    keep: (mediaIds, title) => this.request("POST", "/v1/library", { json: { media_ids: mediaIds, title } }),
    /** From a Google Drive or Dropbox share link, or any public https link. */
    import: (url, title) => this.request("POST", "/v1/library/import", { json: { url, title } }),
    remove: (mediaId) => this.request("DELETE", `/v1/library/${enc(mediaId)}`),
    /** A short-lived link to download the file. */
    fileUrl: async (mediaId) => {
      const res = await this.doFetch(`${this.base}/v1/library/${enc(mediaId)}/file`, { headers: { authorization: `Bearer ${this.key}` }, redirect: "manual" });
      const location = res.headers.get("location");
      if (location)
        return location;
      throw new ReelspanError(res.status, await res.json().catch(() => ({})));
    }
  };
  /** Captions written by AI (each call uses one AI credit). */
  ai = {
    /** Captions for each network from a video file or public URL: frames and speech are read on the server. */
    captionsFromVideo: (video, opts = {}) => {
      const form = new FormData();
      appendFile(form, "video", video);
      appendFields(form, { platforms: opts.platforms?.join(","), language: opts.language, context: opts.context });
      return this.request("POST", "/v1/ai/video-captions", { form });
    },
    /** Captions for each network from whatever the post has: your text, an uploaded video (mediaId) or photos. */
    writeCaptions: (input2) => this.request("POST", "/v1/ai/adapt-captions", { json: { text: input2.text, notes: input2.notes, media_id: input2.mediaId, photo_media_ids: input2.photoMediaIds, platforms: input2.platforms, kind: input2.kind, language: input2.language } }),
    /** Your captions, adapted to each network's style and limits: `{ youtube: { title: '…' } }`. */
    rewriteCaptions: (content, opts = {}) => this.request("POST", "/v1/ai/rewrite-captions", { json: { content, ...opts } })
  };
  pinterest = {
    /** Creates a board on the profile's Pinterest account. */
    createBoard: (username, name) => this.request("POST", "/v1/pinterest/boards", { json: { profile_username: username, name } })
  };
  analytics = {
    account: (username, platforms) => this.request("GET", `/v1/analytics/${enc(username)}`, { query: { platforms } }),
    history: (username, query = {}) => this.request("GET", `/v1/analytics/${enc(username)}/history`, { query }),
    post: (requestId, platform) => this.request("GET", `/v1/post-analytics/${enc(requestId)}`, { query: { platform } }),
    bestTimes: (username, query = {}) => this.request("GET", `/v1/best-times/${enc(username)}`, { query }),
    report: (username, days = 30) => this.request("GET", `/v1/reports/${enc(username)}`, { query: { days } })
  };
  approvals = {
    /** Scheduled posts by `jobIds`, or every post of a request by `requestIds`. */
    create: (p) => this.request("POST", "/v1/approval-links", { json: { profile_username: p.user, job_ids: p.jobIds, request_ids: p.requestIds, title: p.title, note: p.note, expires_in_days: p.expiresInDays } }),
    list: (username) => this.request("GET", "/v1/approval-links", { query: { profile_username: username } }),
    delete: (id) => this.request("DELETE", `/v1/approval-links/${enc(id)}`)
  };
  webhooks = {
    get: () => this.request("GET", "/v1/webhook"),
    set: (url, events) => this.request("POST", "/v1/webhook", { json: { webhook_url: url, webhook_events: events } }),
    delete: () => this.request("DELETE", "/v1/webhook"),
    test: () => this.request("POST", "/v1/webhook/test"),
    deliveries: (limit) => this.request("GET", "/v1/webhook/deliveries", { query: { limit } }),
    redeliver: (deliveryId) => this.request("POST", `/v1/webhook/deliveries/${enc(deliveryId)}/redeliver`),
    /** A new signing secret; the old one stops working. */
    rotateSecret: () => this.request("POST", "/v1/webhook/secret"),
    /** A profile's own webhook, sent in addition to the account one. */
    profile: {
      get: (username) => this.request("GET", "/v1/profile-webhook", { query: { profile_username: username } }),
      set: (username, url, events) => this.request("POST", "/v1/profile-webhook", { json: { profile_username: username, webhook_url: url, webhook_events: events } }),
      delete: (username) => this.request("DELETE", "/v1/profile-webhook", { json: { profile_username: username } })
    }
  };
};
function anySignal(a, b) {
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([a, b]);
  const c = new AbortController();
  for (const s of [a, b]) {
    if (s.aborted)
      c.abort(s.reason);
    else
      s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
function backoff(attempt) {
  const base = Math.min(8e3, 500 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

// src/main.ts
var VERSION2 = "1.0.0";
var input = (env2, name) => (env2[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
var bool = (v) => /^(true|yes|1|on)$/i.test(v);
var items = (v) => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
var VIDEO = [".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"];
var PHOTO = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic"];
var DOC = [".pdf", ".ppt", ".pptx", ".doc", ".docx"];
var MIME = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf" };
function detectType(media) {
  if (!media.length) return "text";
  const ext = (m) => extname(new URL(m, "file:///").pathname).toLowerCase();
  if (media.every((m) => PHOTO.includes(ext(m)))) return "photos";
  if (media.length === 1 && DOC.includes(ext(media[0]))) return "document";
  if (media.length === 1 && VIDEO.includes(ext(media[0]))) return "video";
  throw new Error(`Can't tell the post type from ${media.join(", ")}. Set the type input (video, photos, text or document).`);
}
function parseExtra(v) {
  if (!v) return {};
  if (v.startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error("extra is not valid JSON.");
    }
  }
  const out = {};
  for (const line of v.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf("=");
    if (i < 1) throw new Error(`extra: expected key=value, got "${line}"`);
    const k = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    const prev = out[k];
    out[k] = prev === void 0 ? val : [...Array.isArray(prev) ? prev : [prev], val];
  }
  return out;
}
function fileInput(m, workspace) {
  if (/^https?:\/\//i.test(m)) return m;
  const p = resolve(workspace, m);
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`No such file in the repository: ${m}`);
  return { data: readFileSync(p), name: basename(p), type: MIME[extname(p).toLowerCase()] };
}
function summarise(r) {
  const results = Array.isArray(r.results) ? r.results : Object.entries(r.results ?? {}).map(([platform, v]) => ({ platform, ...v }));
  const urls = {};
  for (const x of results) if (x.success && x.url) urls[x.platform] = x.url;
  const failed = results.filter((x) => x.success === false && !x.skipped).map((x) => x.platform);
  const succeeded = results.filter((x) => x.success).map((x) => x.platform);
  const status = r.status ?? (r.job_id && !results.length ? "scheduled" : !results.length ? "accepted" : failed.length === results.length ? "failed" : failed.length ? "partial" : "completed");
  return { requestId: r.request_id, jobId: r.job_id, status, urls, failed, succeeded, results };
}
function setOutput(env2, name, value) {
  if (env2.GITHUB_OUTPUT) appendFileSync(env2.GITHUB_OUTPUT, `${name}<<__RS_EOF__
${value}
__RS_EOF__
`);
}
function summary(env2, o, type, platforms) {
  if (!env2.GITHUB_STEP_SUMMARY) return;
  const rows = o.results.length ? o.results.map((x) => `| ${x.platform} | ${x.success ? "\u2705 published" : x.skipped ? "\u23ED\uFE0F skipped" : x.success === false ? `\u274C ${String(x.error ?? "failed").replace(/\|/g, "\\|")}` : "\u23F3 in progress"} | ${x.url ? `[open](${x.url})` : ""} |`) : platforms.map((p) => `| ${p} | ${o.status === "scheduled" ? "\u{1F5D3}\uFE0F scheduled" : "\u23F3 accepted"} | |`);
  const ids = [o.requestId && `request_id \`${o.requestId}\``, o.jobId && `job_id \`${o.jobId}\``].filter(Boolean).join(" \xB7 ");
  appendFileSync(env2.GITHUB_STEP_SUMMARY, `### Reelspan: ${type} post ${o.status}

| Network | Result | Link |
|---|---|---|
${rows.join("\n")}

${ids}
`);
}
async function main(io) {
  const { env: env2, log } = io;
  const get = (n) => input(env2, n);
  const key = get("api-key") || env2.REELSPAN_API_KEY;
  if (!key) throw new Error("Set the api-key input, e.g. api-key: ${{ secrets.REELSPAN_API_KEY }}");
  const profile = get("profile");
  if (!profile) throw new Error("Set the profile input (a profile username from the Reelspan dashboard).");
  const platforms = items(get("platforms"));
  if (!platforms.length) throw new Error("Set the platforms input, e.g. platforms: x, linkedin, bluesky");
  const media = items(get("media"));
  const type = get("type") || detectType(media);
  if (!["video", "photos", "text", "document"].includes(type)) throw new Error(`type must be video, photos, text or document, not "${type}".`);
  const text = get("text");
  if (type === "text" && !text) throw new Error("A text post needs the text input.");
  if (type !== "text" && !media.length) throw new Error(`A ${type} post needs the media input (repository paths or URLs).`);
  const wait = bool(get("wait") || "true");
  const failOn = get("fail-on") || "any";
  const idem = get("idempotency-key") || (env2.GITHUB_RUN_ID ? `gha-${env2.GITHUB_REPOSITORY}-${env2.GITHUB_RUN_ID}-${env2.GITHUB_JOB}-${env2.GITHUB_ACTION}` : randomUUID());
  const common2 = {
    user: profile,
    platforms,
    title: text || void 0,
    description: get("description") || void 0,
    scheduledDate: get("scheduled-date") || void 0,
    timezone: get("timezone") || void 0,
    addToQueue: bool(get("add-to-queue")),
    firstComment: get("first-comment") || void 0,
    externalId: get("external-id") || void 0,
    extra: parseExtra(get("extra")),
    idempotencyKey: idem,
    async: wait
  };
  if (bool(get("dry-run"))) {
    log(`Dry run: would post a ${type} to ${platforms.join(", ")} for ${profile}: ${JSON.stringify({ ...common2, idempotencyKey: void 0, media })}`);
    setOutput(env2, "status", "dry-run");
    return 0;
  }
  const client = new Reelspan({ apiKey: key, baseUrl: get("base-url") || env2.REELSPAN_BASE_URL || void 0, fetch: io.fetch, headers: { "x-reelspan-client": `github-action/${VERSION2}` } });
  const ws = env2.GITHUB_WORKSPACE ?? process.cwd();
  log(`Posting a ${type} to ${platforms.join(", ")} for ${profile}\u2026`);
  let r;
  if (type === "video") r = await client.posts.video({ ...common2, video: fileInput(media[0], ws), thumbnail: get("thumbnail") ? fileInput(get("thumbnail"), ws) : void 0 });
  else if (type === "photos") r = await client.posts.photos({ ...common2, photos: media.map((m) => fileInput(m, ws)), altTexts: items(get("alt-text")).length ? get("alt-text").split("\n").map((s) => s.trim()).filter(Boolean) : void 0 });
  else if (type === "document") r = await client.posts.document({ ...common2, document: fileInput(media[0], ws) });
  else r = await client.posts.text(common2);
  if (wait && r.request_id && !r.job_id && !(r.results && Object.keys(r.results).length)) {
    log(`Waiting for every network (request ${r.request_id})\u2026`);
    r = { request_id: r.request_id, ...await client.posts.wait(r.request_id, { timeoutMs: Number(get("wait-timeout") || 600) * 1e3, intervalMs: Number(env2.REELSPAN_POLL_MS) || 5e3 }) };
  }
  let o = summarise(r);
  if (Number(env2.GITHUB_RUN_ATTEMPT) > 1 && o.failed.length && o.requestId && !get("idempotency-key")) {
    log(`Re-run: retrying ${o.failed.join(", ")} (request ${o.requestId})\u2026`);
    let rr = await client.posts.retry(o.requestId, { platforms: o.failed });
    if (wait && !(rr.results && Object.keys(rr.results).length)) rr = await client.posts.wait(o.requestId, { timeoutMs: Number(get("wait-timeout") || 600) * 1e3, intervalMs: Number(env2.REELSPAN_POLL_MS) || 5e3 });
    o = summarise({ request_id: o.requestId, ...rr });
  }
  for (const x of o.results) log(`${x.success ? "\u2713" : x.success === false ? "\u2717" : "\u2026"} ${x.platform} ${x.url ?? x.error ?? ""}`.trimEnd());
  log(`Status: ${o.status}${o.requestId ? ` (request ${o.requestId})` : ""}${o.jobId ? ` (job ${o.jobId})` : ""}`);
  setOutput(env2, "request-id", o.requestId ?? "");
  setOutput(env2, "job-id", o.jobId ?? "");
  setOutput(env2, "status", o.status);
  setOutput(env2, "post-urls", JSON.stringify(o.urls));
  setOutput(env2, "failed-platforms", o.failed.join(","));
  setOutput(env2, "results", JSON.stringify(o.results));
  summary(env2, o, type, platforms);
  if (failOn === "any" && o.failed.length) return fail(log, `Failed on ${o.failed.join(", ")}. Re-run the job to retry only those networks.`);
  if (failOn === "all" && o.failed.length && !o.succeeded.length) return fail(log, "Every network failed.");
  return 0;
}
function fail(log, msg) {
  log(`::error title=Reelspan::${msg}`);
  return 1;
}
async function entry() {
  try {
    process.exitCode = await main({ env: process.env, log: (s) => console.log(s) });
  } catch (err) {
    const e = err;
    const msg = err instanceof ReelspanError ? `Reelspan answered ${err.status}${err.code ? ` ${err.code}` : ""}: ${err.message}` : e.message;
    console.log(`::error title=Reelspan::${msg.replace(/\r?\n/g, "%0A")}`);
    process.exitCode = 1;
  }
}

// src/index.ts
void entry();
