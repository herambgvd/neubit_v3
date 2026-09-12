# SonarQube triage

First scan: **2026-09-11**, 130,806 lines, project key `neubit`.

Every finding below was READ before it was judged. Sonar is a good reader of
patterns and a poor reader of intent, and a dashboard where the noise is never
answered stops being looked at — so this file records the judgement, in the repo,
where it can be argued with.

## What was fixed

| | first scan | 2026-09-12 |
|---|---|---|
| Security issues | 27 | **0** — **A** |
| Reliability issues | 172 | **96** — **B**, and see the waivers below |
| Maintainability issues | 2,625 | 2,494 — **A** |
| Duplication | — | **1.0 %** |
| Quality gate | FAILED | **PASSED** |

Note that the counts above are Sonar's MQR (software-quality impact) view, not the
legacy `bugs` / `vulnerabilities` metrics — the two disagree, and the dashboard
shows MQR. An MQR rating is set by the HIGHEST-severity issue of that quality, not
by the count: reliability is **B** because LOW-severity findings remain, and it
cannot reach **A** while any reliability finding is open at all.

One finding remains, and it is the only one in the repo that cannot be fixed
without breaking the product. It is documented below as a waiver.

The second pass exists because a report goes to STQC, and "explained away" is a
weaker answer than "gone". Of the 28 findings judged false positives after the
first pass, 27 could be made to stop being findings without pretending anything —
so they were, and several of those changes are improvements on their own merits.

The fixes are in `35dcac8` and the commit that follows it. The ones worth naming:

* **The OIDC `id_token` signature was never verified.** Production decoded it with
  `verify_signature: False`; `_map_claims` turns that token's `email` into a user
  identity. Verification is now the default, with the test seam as a parameter
  rather than the check being off for everybody so a mock could pass. Audience and
  issuer are checked, and the provider's advertised algorithm list can only NARROW
  ours — honouring an advertised `HS256` would invite verifying an HMAC whose
  shared secret is the IdP's public key.
* **Seven service images ran as root.** Now uid 10001, gid pinned. `ops-agent`
  stays root and says why in its own Dockerfile: it holds the docker socket.
* **A relay that never releases.** Both linkage undo steps used
  `asyncio.create_task` with the result discarded; the loop holds such a task only
  weakly, so it can be collected mid-await. Losing that one leaves a gate open.
* **Timestamps sorted as text.** ISO-8601 compares correctly character by character
  only while every string has the same shape, and the recorder trims fractional
  seconds — so `…56.4Z` sorted after `…56.42Z`.
* **CORS was the innermost middleware**, so a 429 / 402 / 413 raised outside it
  reached a browser with no `Access-Control-Allow-Origin` and read as a CORS
  failure. It is now outermost.
* **Ten controls a keyboard could not reach** — among them resetting a user's MFA
  and uploading a floor plan, whose file input is `display:none`.

## The one waiver

**`python:S4790` — SHA-1 in `core/app/auth/security.py`.**

It is HMAC-SHA1 inside a TOTP implementation. RFC 6238 §1.2 specifies HMAC-SHA-1
as the default, and every authenticator application in circulation — Google
Authenticator, Microsoft Authenticator, Authy, 1Password — assumes it. Changing it
would invalidate every code already enrolled on every user's phone.

SHA-1's weakness is COLLISION resistance, which matters for signatures and
certificates. HMAC does not rely on collision resistance; HMAC-SHA1 has no
practical attack and is not deprecated for this use (NIST SP 800-107 Rev. 1 §5.3.4
says so explicitly). The finding is a pattern match on the algorithm name, not on
how it is used.

Nothing else in the codebase uses SHA-1: password hashing is Argon2, tokens are
HS256, and evidence checksums are SHA-256.

## What the second pass changed rather than waived

* **Every container is non-root**, ops-agent included. The socket is mode 0660, so
  what it needs is the socket's GROUP, not uid 0 — supplied per-deployment because
  that gid differs by host.
* **One source of randomness.** `crypto.getRandomValues` and `secrets` throughout,
  behind `lib/random`, which rejects modulo bias rather than taking `byte % n`.
* **`$ref` validation became an ALLOW-LIST.** It listed the five schemes somebody
  thought of to refuse; `data:`, `jar:`, `gopher:` and a bare relative path were
  all permitted by omission. It now asks whether a ref is local, which is closed by
  construction. Seven tests fail against the old block-list.
* **The restore dump left /tmp** — world-writable as well as world-readable, so the
  path could be pre-created and written through as a symlink.
* **`database_url` lost its default entirely.** With a password it is a credential
  in version control; without one it is a passwordless database. Getting the
  opposite complaint for the opposite fix is the tell that the default was wrong.
* **Backdrops became real buttons**, out of the tab order and hidden from assistive
  tech where a dialog already has a named close control.

## The first pass, for the record

### Answered at the time — since fixed rather than waived

These are not "ignore"; each has a reason, and the reason is the thing to
re-examine if the code around it changes. The analysis token cannot mark issues in
SonarQube (it is a project-analysis token, which is correct), so the reasons live
here. Mark them **False Positive** in the UI with these notes if you want the
dashboard to agree.

| Rule | Where | Why it stays |
|---|---|---|
| `python:S4790` SHA-1 | `auth/security.py` HOTP | HMAC-SHA1 is what RFC 6238 MANDATES for TOTP. SHA-1 is not broken for HMAC, and changing it breaks every authenticator app a user has already enrolled. |
| `docker:S6471` root | `ops-agent/Dockerfile` | The privileged infra sidecar by design: it holds `/var/run/docker.sock`, and reaching that needs root or a host docker gid that differs per machine. Every other image was moved off root — that is the containment. |
| `secrets:S6698` | `kernel/config.py`, `reading-writer/run-tests.sh` | A local dev default overridden by `VE_DATABASE_URL` wherever it is deployed, and a literal `unused:unused` in a runner that executes with `--network none`. |
| `python:S5443` `/tmp` | `ops-agent/main.py` | A CONTAINER's `/tmp`, staged with `put_archive`, which cannot target a private directory that does not exist yet. Mitigated instead: an unpredictable uuid name, mode `0600` carried in the tar, and removal in a `finally`. |
| `S2245` weak RNG | jitter, draft ids, demo picker | None of these values guards anything. A CSPRNG for a retry backoff would make a claim about the value that is not true. |
| `S5332` http | ingest blocklist, two form placeholders, two SSR URL bases | The ingest one is a BLOCKLIST — the `http://` flagged is the string being refused. The placeholders show the shape of an on-prem appliance URL. The URL bases parse a RELATIVE url during SSR and are never fetched. |
| `typescript:S1082` a11y | 5 backdrops + 1 `stopPropagation` guard | Each component was checked and already handles Escape, so the keyboard route exists; the guard sits on a `<label>` wrapping a real checkbox. The ten that were genuinely unreachable are fixed. |
| `python:S7497` CancelledError | two `stop()` methods | `stop()` is the CANCELLER: it cancels the task and awaits it, so absorbing the acknowledgement is the correct shutdown idiom. The task BODIES were the real finding and now re-raise. |
| `typescript:S6959` `reduce` | `IncidentMap` | "Highest priority" has no identity element, and a fabricated seed would colour a cluster by a priority no alarm in it holds. `items` is non-empty by construction. |

## Code smells: 2,646, and why they are not a task

The top five rules are 1,609 of them:

| Count | Rule | What it asks for |
|---|---|---|
| 552 | `typescript:S6759` | wrap every component's props in `Readonly<>` |
| 391 | `typescript:S3358` | extract every nested ternary |
| 329 | `python:S8410` | use `Annotated[...]` for FastAPI dependencies |
| 232 | `python:S8409` | drop `response_model` where the return type says it |
| 105 | `python:S9073` | split composite assertions in tests |

None of these changes behaviour. Applying them would produce a diff touching most
of the repo, in exchange for a number. The maintainability rating is already **A**
— Sonar's own view is that this debt is small relative to the size of the code.

The two worth doing when there is a reason to touch those files anyway:

* `python:S3776` / `typescript:S3776` (151) — cognitive complexity. Real, but it
  needs a judgement per function, not a sweep.
* `typescript:S1874` (77) — deprecated React types. Worth a look before the next
  React major, because that one becomes a build failure rather than a smell.

**The recommendation is to tune the quality profile rather than the code**: turn
off S6759, S3358, S8409 and S8410 for this project. A rule nobody intends to act
on is a rule that hides the ones somebody should.

## Quality-profile waivers (2026-09-12)

Two rules are deactivated for this project. Both profiles are copies of the
built-in `Sonar way` with exactly ONE rule removed each — verified by diffing the
active-rule sets, not assumed:

    py : Sonar way 398 rules -> "neubit Python"     397   (python:S7503 removed)
    ts : Sonar way 435 rules -> "neubit TypeScript" 434   (typescript:S4084 removed)

A copy does not inherit future updates to `Sonar way`, so on a SonarQube upgrade
these two profiles need re-copying. That is the cost of the waiver and it is
deliberate: SonarQube does not allow a rule inherited from a parent profile to be
deactivated in a child, so an inheriting profile could not express this at all.

### `python:S7503` — "Async functions should use async features" (74 findings)

All 76 occurrences were opened and classified before this was turned off:

| | |
|---|---|
| 50 | FastAPI route handlers and `Depends()` dependencies. Removing `async` does not tidy them — it moves the work to a threadpool. For the auth and DB-session dependencies in `kernel/auth.py` that is a change to how every request in every service is executed. |
| 19 | Callback contracts — NATS subscription callbacks, ASGI `receive`, the `error_cb`/`disconnected_cb`/`reconnected_cb` handed to `nats.connect()`, and lifespan `start()` methods paired with a `stop()` that genuinely awaits. |
| 4 | Async protocol members: `aclose`, and overrides of async base-class methods whose other implementations do await. |
| 3 | Genuinely removable. |

Of the three removable ones, two were not "delete the keyword" findings at all —
`_convert_pdf` and `_convert_dxf` in `sites/floor/floorplan_converter.py` had no
`await` because they ran blocking poppler and matplotlib work INLINE on the event
loop, stalling every SSE stream in `core` for the length of a floor-plan render.
They are fixed (`asyncio.to_thread`, with the matplotlib figure lifetime
serialised), which also removes them from this rule because the `await` is now
real. The rule found a genuine availability bug and filed it as a style nit.

The rule was turned off only after that bug was fixed, so it is not hiding a live
finding. The remaining 74 are framework contracts the analyser cannot see, and a
96 %-false-positive wall on every scan is how a dashboard stops being read.

### `typescript:S4084` — "Media elements should have captions" (2 findings)

`LivePlayer` and `TilePlayback`, both rendering a LIVE CCTV stream. There is no
caption track for a camera feed and there is no way to produce one. Satisfying the
rule would mean adding an empty `<track>` element that claims captions exist.

### Not waived, though it was proposed: `typescript:S6772`

This one was initially judged a false positive and that judgement was wrong. The
sites were read, and the rule is right: in JSX, whether a space survives between an
element and adjacent text depends on the line breaks, not on the space that was
typed. `<kbd>N</kbd> next` renders "N next" until a formatter moves `next` onto its
own line, at which point it silently becomes "Nnext". The 20 sites are being made
explicit rather than waived.
