# Changelog

## 1.0.1

- Built with the latest Reelspan SDK, which drops Whop, Listmonk, Nostr and Lemmy.

## 1.0.0

First release.

- Video, photos (carousel), text and document posts to every network; the type is detected from the media.
- Media from the repository or public URLs (Drive and Dropbox links work); big files go up in parts.
- Scheduling, the queue, first comments, alt text, thumbnails and any other API field through `extra`.
- Waits for every network and reports each one in the job summary, with `post-urls`, `failed-platforms` and `results`
  outputs. `fail-on: any | all | none`.
- Re-running a job never posts twice: the idempotency key is tied to the workflow step, and a re-run retries only the
  networks that failed.
- `dry-run` to check a workflow without posting.
