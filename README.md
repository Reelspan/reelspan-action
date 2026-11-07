# Reelspan Social Publisher

A GitHub Action that publishes videos, photos, text and PDFs to TikTok, YouTube, Instagram, Facebook, X, Threads,
LinkedIn, Pinterest, Bluesky, Reddit, Mastodon, Discord, Telegram, Slack and more with
[Reelspan](https://reelspan.com). Announce releases, ship demo videos, post changelog cards.

```yaml
- uses: Reelspan/reelspan-action@v1
  with:
    api-key: ${{ secrets.REELSPAN_API_KEY }}
    profile: my-brand
    platforms: x, linkedin, bluesky, threads
    text: "${{ github.event.release.name }} is out: ${{ github.event.release.html_url }}"
```

## Set up

1. In Reelspan, create a profile and connect its accounts, then create an API key (**Developers → API keys**).
2. In your repository: **Settings → Secrets and variables → Actions → New repository secret**, name it
   `REELSPAN_API_KEY`.

## Examples

### Announce every release

```yaml
name: Announce release
on:
  release:
    types: [published]
jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - uses: Reelspan/reelspan-action@v1
        with:
          api-key: ${{ secrets.REELSPAN_API_KEY }}
          profile: my-brand
          platforms: x, linkedin, bluesky, mastodon, discord
          text: |
            ${{ github.event.release.name }} is out 🚀
            ${{ github.event.release.html_url }}
          external-id: ${{ github.event.release.tag_name }}
```

### A demo video from the repository, scheduled

```yaml
      - uses: actions/checkout@v4
      - uses: Reelspan/reelspan-action@v1
        id: post
        with:
          api-key: ${{ secrets.REELSPAN_API_KEY }}
          profile: my-brand
          platforms: tiktok, youtube, instagram
          media: assets/demo.mp4
          text: "New in v2: offline mode"
          scheduled-date: 2026-12-01T09:00:00
          timezone: America/New_York
          extra: |
            privacy_level=PUBLIC_TO_EVERYONE
            youtube_tags=release,demo
      - run: echo "Scheduled as ${{ steps.post.outputs.job-id }}"
```

### A carousel, then use the links

```yaml
      - uses: Reelspan/reelspan-action@v1
        id: post
        with:
          api-key: ${{ secrets.REELSPAN_API_KEY }}
          profile: my-brand
          platforms: instagram, linkedin
          media: |
            screenshots/before.png
            screenshots/after.png
          alt-text: |
            The old dashboard
            The new dashboard
          text: Before and after
      - run: echo '${{ steps.post.outputs.post-urls }}' | jq -r .instagram
```

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | required | Your API key, from a secret |
| `profile` | required | The profile whose accounts post |
| `platforms` | required | Comma- or newline-separated |
| `type` | detected | `video`, `photos`, `text` or `document` |
| `text` | | Caption, post text or YouTube title. Long text becomes a thread on X and Bluesky |
| `description` | | Longer description where the network has one |
| `media` | | Repository paths or public URLs, comma- or newline-separated |
| `thumbnail` | | Video thumbnail, path or URL |
| `alt-text` | | One line per photo, in order |
| `scheduled-date` | | ISO-8601; with `timezone` for a local time |
| `timezone` | | IANA name, e.g. `Europe/Berlin` |
| `add-to-queue` | `false` | Take the profile's next free queue slot |
| `first-comment` | | Posted as the first comment |
| `external-id` | | Your id, echoed in webhooks and history |
| `extra` | | Any other API field: JSON or `key=value` lines. Upload-Post field names work too |
| `wait` | `true` | Wait for every network and report each result |
| `wait-timeout` | `600` | Seconds |
| `fail-on` | `any` | `any` failed network fails the step, `all` only if all failed, `none` never |
| `idempotency-key` | per step and run | Same key, one post |
| `dry-run` | `false` | Log what would be sent, send nothing |

## Outputs

`request-id`, `job-id`, `status` (`completed`, `partial`, `failed`, `scheduled`, `accepted`, `dry-run`), `post-urls`
(JSON object of network to URL), `failed-platforms`, `results` (JSON array). Every run also writes a table of results
to the job summary.

## Re-runs are safe

Each step gets an idempotency key made from the repository, run id, job and step, so **Re-run jobs** never publishes a
second copy. If some networks failed the first time, the re-run sends only those again.

## Links

[API reference](https://reelspan.com/docs) · [CLI](https://github.com/Reelspan/reelspan-cli) ·
[Node SDK](https://github.com/Reelspan/reelspan-node)

MIT licensed. Security reports: see [SECURITY.md](SECURITY.md).
