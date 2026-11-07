// Reelspan GitHub Action: publish a release note, a demo video or a changelog card to every major social network from a
// workflow. No @actions/* dependencies: inputs come from INPUT_* variables and outputs go to $GITHUB_OUTPUT.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Reelspan, ReelspanError, type FileInput, type PostCommon, type Json } from 'reelspan';

export const VERSION = '1.0.0';
type Env = Record<string, string | undefined>;
type Type = 'video' | 'photos' | 'text' | 'document';

export const input = (env: Env, name: string) => (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
const bool = (v: string) => /^(true|yes|1|on)$/i.test(v);
/** Non-empty lines (alt texts may contain commas). */
const lines = (v: string) => {
  const l = v.split('\n').map((s) => s.trim()).filter(Boolean);
  return l.length ? l : undefined;
};
/** A list from commas or new lines. */
export const items = (v: string) => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

const VIDEO = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'];
const PHOTO = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic'];
const DOC = ['.pdf', '.ppt', '.pptx', '.doc', '.docx'];
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };

/** The post type from the media's file extensions when `type` isn't given. */
export function detectType(media: string[]): Type {
  if (!media.length) return 'text';
  const ext = (m: string) => extname(new URL(m, 'file:///').pathname).toLowerCase();
  if (media.every((m) => PHOTO.includes(ext(m)))) return 'photos';
  if (media.length === 1 && DOC.includes(ext(media[0]))) return 'document';
  if (media.length === 1 && VIDEO.includes(ext(media[0]))) return 'video';
  throw new Error(`Can't tell the post type from ${media.join(', ')}. Set the type input (video, photos, text or document).`);
}

/** `extra` as a JSON object or key=value lines. */
export function parseExtra(v: string): Record<string, string | string[]> {
  if (!v) return {};
  if (v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      throw new Error('extra is not valid JSON.');
    }
  }
  const out: Record<string, string | string[]> = {};
  for (const line of v.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf('=');
    if (i < 1) throw new Error(`extra: expected key=value, got "${line}"`);
    const k = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    const prev = out[k];
    out[k] = prev === undefined ? val : [...(Array.isArray(prev) ? prev : [prev]), val];
  }
  return out;
}

function fileInput(m: string, workspace: string): FileInput {
  if (/^https?:\/\//i.test(m)) return m;
  const p = resolve(workspace, m);
  if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`No such file in the repository: ${m}`);
  return { data: readFileSync(p), name: basename(p), type: MIME[extname(p).toLowerCase()] };
}

export type Outcome = { requestId?: string; jobId?: string; status: string; urls: Record<string, string>; failed: string[]; succeeded: string[]; results: Json[] };

export function summarise(r: Json): Outcome {
  const results: Json[] = Array.isArray(r.results) ? r.results : Object.entries(r.results ?? {}).map(([platform, v]) => ({ platform, ...(v as Json) }));
  const urls: Record<string, string> = {};
  for (const x of results) if (x.success && x.url) urls[x.platform] = x.url;
  const failed = results.filter((x) => x.success === false && !x.skipped).map((x) => x.platform);
  const succeeded = results.filter((x) => x.success).map((x) => x.platform);
  const status = r.status ?? (r.job_id && !results.length ? 'scheduled' : !results.length ? 'accepted' : failed.length === results.length ? 'failed' : failed.length ? 'partial' : 'completed');
  return { requestId: r.request_id, jobId: r.job_id, status, urls, failed, succeeded, results };
}

type Io = { env: Env; fetch?: typeof fetch; log: (s: string) => void };

function setOutput(env: Env, name: string, value: string) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}<<__RS_EOF__\n${value}\n__RS_EOF__\n`);
}

function summary(env: Env, o: Outcome, type: Type, platforms: string[]) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const rows = o.results.length
    ? o.results.map((x) => `| ${x.platform} | ${x.success ? '✅ published' : x.skipped ? '⏭️ skipped' : x.success === false ? `❌ ${String(x.error ?? 'failed').replace(/\|/g, '\\|')}` : '⏳ in progress'} | ${x.url ? `[open](${x.url})` : ''} |`)
    : platforms.map((p) => `| ${p} | ${o.status === 'scheduled' ? '🗓️ scheduled' : '⏳ accepted'} | |`);
  const ids = [o.requestId && `request_id \`${o.requestId}\``, o.jobId && `job_id \`${o.jobId}\``].filter(Boolean).join(' · ');
  appendFileSync(env.GITHUB_STEP_SUMMARY, `### Reelspan: ${type} post ${o.status}\n\n| Network | Result | Link |\n|---|---|---|\n${rows.join('\n')}\n\n${ids}\n`);
}

export async function main(io: Io): Promise<number> {
  const { env, log } = io;
  const get = (n: string) => input(env, n);
  const key = get('api-key') || env.REELSPAN_API_KEY;
  if (!key) throw new Error('Set the api-key input, e.g. api-key: ${{ secrets.REELSPAN_API_KEY }}');
  const profile = get('profile');
  if (!profile) throw new Error('Set the profile input (a profile username from the Reelspan dashboard).');
  const platforms = items(get('platforms'));
  if (!platforms.length) throw new Error('Set the platforms input, e.g. platforms: x, linkedin, bluesky');
  const media = items(get('media'));
  const type = (get('type') || detectType(media)) as Type;
  if (!['video', 'photos', 'text', 'document'].includes(type)) throw new Error(`type must be video, photos, text or document, not "${type}".`);
  const text = get('text');
  if (type === 'text' && !text) throw new Error('A text post needs the text input.');
  if (type !== 'text' && !media.length) throw new Error(`A ${type} post needs the media input (repository paths or URLs).`);
  const wait = bool(get('wait') || 'true');
  const failOn = (get('fail-on') || 'any') as 'any' | 'all' | 'none';
  // the same workflow step on a re-run gets the same key, so re-running a job never posts twice
  const idem = get('idempotency-key') || (env.GITHUB_RUN_ID ? `gha-${env.GITHUB_REPOSITORY}-${env.GITHUB_RUN_ID}-${env.GITHUB_JOB}-${env.GITHUB_ACTION}` : randomUUID());

  const common: PostCommon = {
    user: profile,
    platforms,
    title: text || undefined,
    description: get('description') || undefined,
    scheduledDate: get('scheduled-date') || undefined,
    timezone: get('timezone') || undefined,
    addToQueue: bool(get('add-to-queue')),
    firstComment: get('first-comment') || undefined,
    externalId: get('external-id') || undefined,
    extra: parseExtra(get('extra')),
    idempotencyKey: idem,
    async: wait,
  };

  if (bool(get('dry-run'))) {
    log(`Dry run: would post a ${type} to ${platforms.join(', ')} for ${profile}: ${JSON.stringify({ ...common, idempotencyKey: undefined, media })}`);
    setOutput(env, 'status', 'dry-run');
    return 0;
  }

  const client = new Reelspan({ apiKey: key, baseUrl: get('base-url') || env.REELSPAN_BASE_URL || undefined, fetch: io.fetch, headers: { 'x-reelspan-client': `github-action/${VERSION}` } });
  const ws = env.GITHUB_WORKSPACE ?? process.cwd();
  log(`Posting a ${type} to ${platforms.join(', ')} for ${profile}…`);
  let r: Json;
  if (type === 'video') r = await client.posts.video({ ...common, video: fileInput(media[0], ws), thumbnail: get('thumbnail') ? fileInput(get('thumbnail'), ws) : undefined });
  else if (type === 'photos') r = await client.posts.photos({ ...common, photos: media.map((m) => fileInput(m, ws)), altTexts: items(get('alt-text')).length ? get('alt-text').split('\n').map((s) => s.trim()).filter(Boolean) : undefined });
  else if (type === 'document') r = await client.posts.document({ ...common, document: fileInput(media[0], ws) });
  else r = await client.posts.text(common);

  if (wait && r.request_id && !r.job_id && !(r.results && Object.keys(r.results).length)) {
    log(`Waiting for every network (request ${r.request_id})…`);
    r = { request_id: r.request_id, ...(await client.posts.wait(r.request_id, { timeoutMs: Number(get('wait-timeout') || 600) * 1000, intervalMs: Number(env.REELSPAN_POLL_MS) || 5000 })) };
  }
  let o = summarise(r);
  // a re-run of the job replays the same idempotency key, so the API answers with the first attempt's result: send
  // the networks that failed again instead
  if (Number(env.GITHUB_RUN_ATTEMPT) > 1 && o.failed.length && o.requestId && !get('idempotency-key')) {
    log(`Re-run: retrying ${o.failed.join(', ')} (request ${o.requestId})…`);
    let rr: Json = await client.posts.retry(o.requestId, { platforms: o.failed });
    if (wait && !(rr.results && Object.keys(rr.results).length)) rr = await client.posts.wait(o.requestId, { timeoutMs: Number(get('wait-timeout') || 600) * 1000, intervalMs: Number(env.REELSPAN_POLL_MS) || 5000 });
    o = summarise({ request_id: o.requestId, ...rr });
  }
  for (const x of o.results) log(`${x.success ? '✓' : x.success === false ? '✗' : '…'} ${x.platform} ${x.url ?? x.error ?? ''}`.trimEnd());
  log(`Status: ${o.status}${o.requestId ? ` (request ${o.requestId})` : ''}${o.jobId ? ` (job ${o.jobId})` : ''}`);
  setOutput(env, 'request-id', o.requestId ?? '');
  setOutput(env, 'job-id', o.jobId ?? '');
  setOutput(env, 'status', o.status);
  setOutput(env, 'post-urls', JSON.stringify(o.urls));
  setOutput(env, 'failed-platforms', o.failed.join(','));
  setOutput(env, 'results', JSON.stringify(o.results));
  summary(env, o, type, platforms);

  if (failOn === 'any' && o.failed.length) return fail(log, `Failed on ${o.failed.join(', ')}. Re-run the job to retry only those networks.`);
  if (failOn === 'all' && o.failed.length && !o.succeeded.length) return fail(log, 'Every network failed.');
  return 0;
}

function fail(log: (s: string) => void, msg: string) {
  log(`::error title=Reelspan::${msg}`);
  return 1;
}

export async function entry() {
  try {
    process.exitCode = await main({ env: process.env, log: (s) => console.log(s) });
  } catch (err) {
    const e = err as Error;
    const msg = err instanceof ReelspanError ? `Reelspan answered ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}` : e.message;
    console.log(`::error title=Reelspan::${msg.replace(/\r?\n/g, '%0A')}`);
    process.exitCode = 1;
  }
}
