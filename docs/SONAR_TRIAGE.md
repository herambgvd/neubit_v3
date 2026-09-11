# SonarQube triage

First scan: **2026-09-11**, 130,806 lines, project key `neubit`.

Every finding below was READ before it was judged. Sonar is a good reader of
patterns and a poor reader of intent, and a dashboard where the noise is never
answered stops being looked at — so this file records the judgement, in the repo,
where it can be argued with.

## What was fixed

| | before | after |
|---|---|---|
| Bugs | 41 | 9 |
| Vulnerabilities | 27 | 19 |

Everything remaining in those two columns is listed under **Answered** below.

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

## Answered: why the remaining findings stay

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
