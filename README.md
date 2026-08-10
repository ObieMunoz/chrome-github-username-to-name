# GitHub Username Renamer

A Chrome extension that shows real names instead of GitHub usernames across
github.com. Map `u1069002` to `Obie Munoz` once and it reads that way
everywhere — PR lists, comments, replies, issues, reviewers, commits, blame,
notifications, hovercards.

Replaced names are shown in neon green with a dotted underline, so you always
know what the extension touched. Profile links keep working exactly as before.

## Install

1. `git clone` this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this folder.
5. Pin the extension so the popup is one click away.

There is no build step — the folder is the extension.

## Use

**Add a name:** click the toolbar icon, type the username and what to show
instead, hit Add. Changes apply to open GitHub tabs immediately; no reload.

**Add one from the page:** hover any username to bring up GitHub's own profile
card — it now carries a **Show as a real name…** row at the bottom. Click it,
type the name, press Enter. The page repaints everywhere at once.

Once mapped, that row reads **Showing as "…"** and offers Remove, so the
hovercard doubles as the edit surface.

**Or right-click:** anywhere on GitHub, choose **Replace this GitHub
username…**. Right-clicking a profile link or a selected username prefills it;
elsewhere the popup just opens ready for input.

**Pause everything:** the switch in the popup header turns all replacement off
without deleting anything — handy when you need to read a page as it really is,
or screenshot it for someone else.

**Back up:** Export writes a JSON file; Import merges one back in. Mappings are
also stored in `chrome.storage.sync`, so they follow your Chrome profile across
machines on their own.

## What it deliberately does not touch

The engine rewrites visible text only, and skips anywhere a rewrite would do
real damage:

| Skipped | Why |
| --- | --- |
| `textarea`, `input`, `contenteditable`, `role="textbox"` | GitHub's comment box is a real editor. Rewriting it would change what you actually submit. |
| `code`, `pre`, `kbd`, `samp` | A username in a code block is usually part of a command or path, where a silent rewrite hands you a broken copy-paste. |
| Text containing a URL | Rewriting `https://github.com/u1069002` would make the visible text disagree with where the link goes. |
| Links to a repo's home page | A repo slug is an identifier, not a person. `ObieMunoz / obiemunoz.com` renders as `Obie Munoz / obiemunoz.com` — the owner is a person, the repo name is not. Only exactly-two-segment paths are skipped, so a PR title at `/owner/repo/pull/12` can still name someone. |
| `href` attributes | Only text nodes are touched, so links keep pointing where GitHub put them. |
| Avatar `alt` / `title` attributes | Left raw on purpose, so hovering always gets you back to the real username. |

Matching is case-insensitive and boundary-aware: `u1069002` will not match
inside `u10690021`, `u1069002-bot`, `team-u1069002`, or `foo@u1069002.com`.
Boundaries use explicit lookarounds rather than `\b`, because GitHub usernames
can contain hyphens.

A trailing dot is read in context, so a username that is also a domain stays
intact: `obiemunoz.com` is left alone, while `thanks obiemunoz.` at the end of
a sentence still gets replaced.

Email addresses are left verbatim on both sides of the `@`, because a rewritten
address is no longer the address. That covers the merge screen's "This commit
will be authored by `95655512+obiemunoz@users.noreply.github.com`", which is
still an address even though your username is sitting in the middle of it.

## How it works

`src/content.js` walks text nodes with a `TreeWalker`, pruning skipped subtrees
outright, and wraps each match in
`<span class="ghun-name" data-ghun-raw="…">`. That one span does four jobs: it
carries the styling, provides the hover tooltip, marks the node so the
`MutationObserver` never reprocesses its own output, and stores the exact
original text so toggling off restores the page losslessly.

Coverage comes from observing DOM mutations rather than from a list of CSS
selectors, so it survives GitHub reshuffling their markup and picks up
async-loaded content like hovercards and lazy comment threads.

### Highlight color

Neon `#39ff14` measures **13.96:1** against GitHub's dark theme and **1.36:1**
against its light theme — unreadable, where 4.5:1 is the accessibility floor.
So light mode uses `#00891c` (4.57:1), which still reads unmistakably as
"this was rewritten". Both are set in `src/content.css`; change them there if
you want pure neon in both themes.

## Layout

```
manifest.json          MV3 manifest
src/common.js          shared helpers — matcher, validation, import parsing
src/content.js         the text-walking engine
src/content.css        the neon styling and injected UI
src/hovercard.js       the "Show as a real name…" row and its editor panel
src/background.js      the right-click menu
src/popup.*            the management UI
test/                  node:test + jsdom
demo/                  offline stand-in page for checking styling and skip rules
tools/make-icons.mjs   regenerates icons from one SVG (macOS `sips`)
```

## Development

```bash
npm install
npm test
```

The demo page runs the real content script against a stubbed `chrome.storage`,
so you can check styling without installing anything:

```bash
python3 -m http.server 8731
```

Then open <http://localhost:8731/demo/demo.html>. It has buttons for flipping
the theme, toggling replacement, and injecting a late comment to exercise the
mutation observer.

After changing extension source, hit reload on the card in `chrome://extensions`
**and** refresh your GitHub tab. Both steps matter: reloading alone leaves the
old `content.css` attached to already-open tabs, which shows up as working
behaviour with no styling.

### Notes on the hovercard row

The username comes from `data-hovercard-url` on the trigger element GitHub
itself annotates (`/users/<login>/hovercard`), not from the popup's markup —
that value is unambiguous and survives their markup changing. It is reassigned
on every hover, including to null, so an organization card can never inherit
the previously hovered user.

The editor panel is appended to `<body>`, deliberately not inside the
hovercard: GitHub tears the hovercard down as soon as the pointer leaves it,
which would destroy an inline form mid-typing. Its position and z-index are set
inline rather than in CSS, so a stale or missing stylesheet can't drop it into
normal page flow.

## Scope

github.com only. Adding a GitHub Enterprise host means adding it to
`host_permissions` and the `content_scripts` match list in `manifest.json`.
