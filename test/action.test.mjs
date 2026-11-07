// Runs the action against a local stand-in for the API (no network): inputs, uploads, outputs, summary, failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, detectType, parseExtra, items, summarise } from './.build/main.js';

const seen = [];
let server, base;
const ws = mkdtempSync(join(tmpdir(), 'reelspan-action-'));
mkdirSync(join(ws, 'media'));
writeFileSync(join(ws, 'media', 'demo.mp4'), 'video-bytes');
writeFileSync(join(ws, 'media', 'a.png'), 'png-a');
writeFileSync(join(ws, 'media', 'b.png'), 'png-b');

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
    const reply = (s, j) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    const path = req.url.split('?')[0];
    if (path === '/v1/posts/text') return reply(202, { success: true, request_id: 'req_t' });
    if (path === '/v1/posts/status') return reply(200, { status: 'completed', results: [{ platform: 'x', success: true, url: 'https://x.com/r/1' }, { platform: 'bluesky', success: false, error: 'Too long | over 300' }] });
    if (path === '/v1/posts/video') return reply(202, { success: true, job_id: 'job_v' });
    if (path === '/v1/posts/photos') return reply(200, { success: true, request_id: 'req_p', results: { instagram: { success: true, url: 'https://instagram.com/p/1' } } });
    if (path === '/v1/posts/retry') return reply(200, { success: true, request_id: 'req_t', results: { bluesky: { success: true, url: 'https://bsky.app/1' } } });
    reply(404, { message: 'nope' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let n = 0;
async function act(inputs, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reelspan-out-'));
  const out = join(dir, 'out');
  const sum = join(dir, 'sum');
  writeFileSync(out, '');
  writeFileSync(sum, '');
  const env = { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_WORKSPACE: ws, GITHUB_RUN_ID: String(++n), GITHUB_REPOSITORY: 'o/r', GITHUB_JOB: 'post', GITHUB_ACTION: 'reelspan', REELSPAN_POLL_MS: '10', 'INPUT_BASE-URL': base, 'INPUT_API-KEY': 'rs_test', INPUT_PROFILE: 'brand', ...extraEnv };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const logs = [];
  const code = await main({ env, log: (s) => logs.push(s) });
  const outputs = {};
  for (const m of readFileSync(out, 'utf8').matchAll(/^(.+?)<<__RS_EOF__\n([\s\S]*?)\n__RS_EOF__$/gm)) outputs[m[1]] = m[2];
  return { code, logs: logs.join('\n'), outputs, summary: readFileSync(sum, 'utf8') };
}

test('text post waits, reports each network and fails on a failed network', async () => {
  const r = await act({ platforms: 'x, bluesky', text: 'Released v2.0', 'first-comment': 'Notes: https://x.y' });
  assert.equal(r.code, 1);
  assert.equal(r.outputs['request-id'], 'req_t');
  assert.equal(r.outputs.status, 'completed');
  assert.deepEqual(JSON.parse(r.outputs['post-urls']), { x: 'https://x.com/r/1' });
  assert.equal(r.outputs['failed-platforms'], 'bluesky');
  assert.match(r.summary, /\| x \| ✅ published \| \[open\]\(https:\/\/x.com\/r\/1\) \|/);
  assert.match(r.summary, /Too long \\\| over 300/);
  assert.match(r.logs, /::error title=Reelspan::Failed on bluesky/);
  const sent = seen.find((s) => s.url === '/v1/posts/text');
  const body = JSON.parse(sent.body);
  assert.deepEqual(body.platform, ['x', 'bluesky']);
  assert.equal(body.async_upload, 'true');
  assert.equal(body.first_comment, 'Notes: https://x.y');
  assert.equal(sent.headers.authorization, 'Bearer rs_test');
  assert.match(sent.headers['idempotency-key'], /^gha-o\/r-\d+-post-reelspan$/);
  assert.match(sent.headers['x-reelspan-client'], /^github-action\//);
});

test('fail-on all passes when one network worked', async () => {
  assert.equal((await act({ platforms: 'x,bluesky', text: 'hi', 'fail-on': 'all' })).code, 0);
});

test('a re-run retries only the failed networks', async () => {
  const r = await act({ platforms: 'x,bluesky', text: 'hi' }, { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(r.code, 0);
  assert.match(r.logs, /Re-run: retrying bluesky/);
  assert.deepEqual(JSON.parse(seen.findLast((s) => s.url === '/v1/posts/retry').body), { request_id: 'req_t', platforms: ['bluesky'] });
});

test('video from the repository, scheduled', async () => {
  const r = await act({ platforms: 'tiktok,youtube', media: 'media/demo.mp4', text: 'Demo', 'scheduled-date': '2026-12-01T09:00:00Z', extra: 'privacy_level=PUBLIC_TO_EVERYONE' });
  assert.equal(r.code, 0);
  assert.equal(r.outputs['job-id'], 'job_v');
  assert.equal(r.outputs.status, 'scheduled');
  assert.match(r.summary, /🗓️ scheduled/);
  const body = seen.findLast((s) => s.url === '/v1/posts/video').body;
  assert.match(body, /filename="demo.mp4"/);
  assert.match(body, /video-bytes/);
  assert.match(body, /name="privacy_level"\r\n\r\nPUBLIC_TO_EVERYONE/);
});

test('photos carousel with alt text', async () => {
  const r = await act({ platforms: 'instagram', media: 'media/a.png\nmedia/b.png', text: 'Before, after', 'alt-text': 'Before, the old one\nAfter' });
  assert.equal(r.code, 0);
  const body = seen.findLast((s) => s.url === '/v1/posts/photos').body;
  assert.equal(body.match(/name="photos\[\]"; filename=/g).length, 2);
  assert.match(body, /name="alt_text\[\]"\r\n\r\nBefore, the old one/);
});

test('dry run sends nothing', async () => {
  const count = seen.length;
  const r = await act({ platforms: 'x', text: 'hi', 'dry-run': 'true' });
  assert.equal(r.code, 0);
  assert.equal(seen.length, count);
  assert.equal(r.outputs.status, 'dry-run');
});

test('clear input errors', async () => {
  await assert.rejects(act({ platforms: '', text: 'x' }), /platforms input/);
  await assert.rejects(act({ platforms: 'x' }), /needs the text input/);
  await assert.rejects(act({ platforms: 'x', media: 'missing.mp4' }), /No such file in the repository: missing.mp4/);
});

test('helpers', () => {
  assert.equal(detectType([]), 'text');
  assert.equal(detectType(['a.mp4']), 'video');
  assert.equal(detectType(['https://cdn.example.com/a.jpg?x=1', 'b.PNG']), 'photos');
  assert.equal(detectType(['deck.pdf']), 'document');
  assert.throws(() => detectType(['a.mp4', 'b.mp4']), /type input/);
  assert.deepEqual(parseExtra('{"a":1}'), { a: 1 });
  assert.deepEqual(parseExtra('a=1\nb = x\nb=y'), { a: '1', b: ['x', 'y'] });
  assert.deepEqual(items('a, b\nc'), ['a', 'b', 'c']);
  assert.equal(summarise({ request_id: 'r', results: { x: { success: false, error: 'e' } } }).status, 'failed');
});
