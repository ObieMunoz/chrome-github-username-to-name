# GitHub Username Renamer

A Chrome extension that shows real names instead of GitHub usernames across
github.com. Map `u1069002` to `Obie Munoz` once and it reads that way
everywhere — PR lists, comments, replies, issues, reviewers, commits, blame,
notifications, hovercards.

Replaced names are shown in neon green with a dotted underline, so you always
know what the extension touched — pick a different color from the wheel in the
popup if you'd rather. Profile links keep working exactly as before.

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

**Pause everything:** the switch in the popup header turns all replacement off
without deleting anything — handy when you need to read a page as it really is,
or screenshot it for someone else.

**Copy, quote and reply as normal:** the name is drawn over the username rather
than written in place of it, so copying a comment — or using GitHub's **Quote
reply** on one — gives you back `@u1069002`, exactly as it was typed. Nothing
you send to GitHub ever carries a name this extension invented. Find-in-page
matches the username for the same reason.

**Change the color:** open **Highlight color** in the popup and click the wheel —
angle is hue, distance from the centre is saturation. Whatever you pick is what
you get, on both of GitHub's themes. The two swatches beside the wheel show it
on each of them with a contrast ratio, so you can see before you commit whether
it will still be readable if you switch. Type a hex for an exact shade, or
**Reset** to go back to the default green.

**Back up:** open **Backup** in the popup. The top box holds your mappings and
your color choice as JSON, with a **Copy** button for putting it somewhere safe;
paste JSON into the bottom box and hit **Import** to merge it back in. Anything
already mapped needs a second Import click before it is overwritten. No files
change hands either way, and both are stored in `chrome.storage.sync` regardless,
so they follow your Chrome profile across machines on their own.

## What it deliberately does not touch

The engine rewrites visible text only, and skips anywhere a rewrite would do
real damage:

| Skipped | Why |
| --- | --- |
| `textarea`, `input`, `contenteditable`, `role="textbox"` | GitHub's comment box is a real editor. Rewriting it would change what you actually submit. |
| `code`, `pre`, `kbd`, `samp` | A username in a code block is usually part of a command or path, where a silent rewrite hands you a broken copy-paste. |
| The file and blame views | Same reason, but they need their own rule: GitHub renders each source line as a plain `div`, so there is no `code` element to match on. Diff views need nothing extra — they do use a real `code` per line. |
| Text containing a URL | Rewriting `https://github.com/u1069002` would make the visible text disagree with where the link goes. |
| Links to a repo's home page | A repo slug is an identifier, not a person. `ObieMunoz / obiemunoz.com` renders as `Obie Munoz / obiemunoz.com` — the owner is a person, the repo name is not. Only exactly-two-segment paths are skipped, so a PR title at `/owner/repo/pull/12` can still name someone. |
| Links marked `rel="me"` | A profile's website, X, LinkedIn, Bluesky and Instagram rows. `@ObieMunoz` under the X icon is a handle on X, an identifier on a service this knows nothing about. GitHub puts `rel="me"` on those rows and nowhere else, and markdown can't set it, so a link in a profile README can't claim it. |
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

A `/` straight after a name means the same thing as one straight before it: this
is the owner segment of a path, not a person. So the branch reference every
merge commit carries in its subject — "Merge pull request #4 from
`ObieMunoz/feature/rewrites-code-blocks`", shown on the repo home page and
against every file it touched — stays exactly as written, as does a repo
reference like `ObieMunoz/site#12`. A breadcrumb spaces its slash out
(`ObieMunoz / obiemunoz.com`), so the owner there is still read as a person.

## How it works

`src/content.js` walks text nodes with a `TreeWalker`, pruning skipped subtrees
outright, and wraps each match in
`<span class="ghun-name" data-ghun-raw="…" data-ghun-shown="…">`. That one span
does four jobs: it carries the styling, provides the hover tooltip, marks the
node so the `MutationObserver` never reprocesses its own output, and stores the
exact original text so toggling off restores the page losslessly.

Coverage comes from observing DOM mutations rather than from a list of CSS
selectors, so it survives GitHub reshuffling their markup and picks up
async-loaded content like hovercards and lazy comment threads.

The one place selectors are unavoidable is the code views, where nothing in the
markup says "this is code". Those match on GitHub's unhashed class names
(`react-file-line`, `react-code-text`) rather than the `*-module__*` ones beside
them, which are build hashes and change without notice.

### The name you see is never in the page

The replacement is drawn by CSS. It is not written into the document:

```html
<span class="ghun-name" data-ghun-shown="@Obie Munoz" data-ghun-raw="@u1069002"
      title="@u1069002"><span class="ghun-source" aria-hidden="true">@u1069002</span></span>
```

```css
.ghun-name::before { content: attr(data-ghun-shown); }
.ghun-source       { font-size: 0 !important; }
```

You read "@Obie Munoz". Everything that reads the page instead of looking at it
— GitHub's own scripts included — reads `@u1069002`, because generated content
is in neither the DOM nor the rendered text, while the zero-size original is in
both.

That split is the difference between changing what a page looks like and
changing what it says, and **Quote reply** is where it earns its keep: GitHub
builds a quote out of the comment's own DOM, not out of the markdown the
comment was written in. It runs `textContent` through a set of markdown filters
and then `selection.toString()` over the result. With a replacement name sitting
in the page as text, quoting a comment that mentioned `@ObieMunoz` pasted

```
> @Obie Munoz (Foot Locker) it's only conditionally included in a certain _type_…
```

into the reply box, and GitHub resolved `@Obie` — an account that exists, and
belongs to someone with no part in the thread. Copying a comment leaked the same
way.

`font-size: 0` rather than `display: none` is the part worth remembering:
`selection.toString()` drops text that isn't rendered, so hiding the username
that way would have deleted it from the quote rather than restoring it. Letter
and word spacing are lengths that survive a zero font size, so they are zeroed
alongside it or an eleven-character username still nudges the line along.

Two things follow. Find-in-page matches `u1069002` and not `Obie Munoz` — the
text that is really there, which is what an unextended GitHub would match too.
And if `content.css` ever fails to load, both rules fail together and the page
reads as plain GitHub: the username, full size, unstyled.

### Highlight color

The default is theme-aware, because one color can't serve both themes. Neon
`#39ff14` measures **13.96:1** against GitHub's dark theme and **1.36:1**
against its light theme — unreadable, where 4.5:1 is the accessibility floor.
So light mode falls back to `#00891c` (4.57:1), which still reads unmistakably
as "this was rewritten". Both live in `src/content.css`, picked between by the
same cascade GitHub's own theming uses: explicit `data-color-mode` first, then
`prefers-color-scheme` for `auto`.

A color you pick yourself is one color, used on both themes. That is a
deliberate trade. An earlier version derived a second variant per theme so a
pick could never go unreadable, and it was worse in every way that mattered: it
turned one choice into two colors you could not see at once, it had to guess
which theme you were in and got that wrong for anyone who set the theme in
GitHub's own settings rather than the OS, and the refit that produced the second
variant is not reversible — so the machinery could walk a chosen color somewhere
else and never walk it back. Switching themes is rare; picking a color again is
one click. The guardrail is now information rather than control: the popup shows
your color on both backgrounds with live contrast ratios, and reddens the ratio
below 4.5:1 instead of overriding you.

`src/content.js` publishes the pick as a single `--ghun-color` on `<html>`,
which outranks the stylesheet and flattens the cascade above. Clearing it —
rather than writing a default back — is what lets `content.css` keep owning the
theme-aware default, so **Reset** restores that behavior exactly.

That property is also the only piece of state living outside the body, where
nothing was rebuilding it: GitHub clears `<html>`'s inline style on some
navigations, and going **Back** from a pull request to the list it was opened
from used to land on a page where every name had dropped to the shipped default
until the next reload. A second observer watches that attribute and puts the
property back the moment it goes missing, so this holds whichever navigation —
and whichever bit of GitHub's own code — clears it.

The wheel covers hue and saturation and is painted at a fixed lightness, and a
click stores that same lightness, so the pixel under the cursor is exactly the
color saved. Anything outside that band goes in the hex field, which repaints
the wheel to match rather than letting the two disagree.

Only the hex is stored. Everything else — the two previews, the ratios — is
recomputed from it.

## Layout

```
manifest.json          MV3 manifest
src/common.js          shared helpers — matcher, validation, import parsing, color maths
src/content.js         the text-walking engine
src/content.css        the highlight styling and injected UI
src/hovercard.js       the "Show as a real name…" row and its editor panel
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
mutation observer. **Quote the last comment** stands in for GitHub's Quote
reply, which is the one behaviour here you can't check by looking at the page:
it prints the text a reply would actually be submitted with, so the username has
to come back out of a comment that reads as a name.

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
