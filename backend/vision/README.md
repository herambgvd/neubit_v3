# vision

The VMS control plane. Cameras, NVR estate, live and playback, PTZ, recording
policy, export and evidence, video walls, and the ONVIF surfaces on both sides —
this service is an ONVIF *client* to cameras and an ONVIF *responder* to a
third-party VMS.

212 routes across 27 routers, and the largest surface on the platform after core.

It is a CONTROL plane, not a data plane. Streams and segments belong to the
recorder (`VE_NVR_URL`, the standalone Go NVR); this service decides which camera
is on which node, who may see it, how long it is kept, and what a browser is
allowed to open.

## Where the tenant comes from

The JWT, and then the row. Every by-id path goes through `assert_owned`, and every
one of those 34 calls now states what it does about a NULL `tenant_id` rather than
taking the default — see below, because the default cost this service a hole.

## Things worth knowing

**A platform media node is readable by everyone and editable by nobody but the
platform.** `kernel.auth.owns()` treats a NULL `tenant_id` as belonging to nobody
and therefore readable by all. That is right for a shared record a tenant may USE,
and the media node is exactly that: the one on a live deployment is the standalone
NVR recorder, `tenant_id` NULL, holding the credential the VMS authenticates to it
with, and a tenant's cameras are assigned to it.

It was wrong for the paths that CHANGE it, and `MediaNodeService._row` served
`get`, `update`, `delete`, `list_credentials`, `enroll_credential` and
`revoke_credential` alike. `MediaNodeUpdate` accepts `host` and `api_url`.
Measured before the fix: a tenant holding `vms.config.manage` PATCHed the platform
recorder and got **200 OK** with `api_url: http://attacker.example:8000`.

`_row` takes `for_write` now. Reads of a shared node still work — that is how a
tenant's cameras find the recorder. Everywhere else in the service passes
`allow_shared=False` outright: no other entity here has a platform-wide form, so a
NULL tenant there is not a shared record, it is a row nobody should reach.
`test_route_inventory.py` fails if any `assert_owned` goes back to the default.

**Six ONVIF SOAP endpoints are unauthenticated on purpose.** ONVIF carries
WS-Security, not a bearer. `/api/v1/vms/media/verify` is public for a different
reason: Traefik's ForwardAuth calls it to verify a stream token, so gating it on a
token would be circular. Those, `/health` and `/readyz` are the whole public set,
and it is a list in the test rather than an accident — a route that loses its gate
fails `test_every_public_route_is_accounted_for`.

**`/readyz` did not exist.** `/health` answered 200 while the process was up and
touched nothing, so an orchestrator could not tell this service from one whose
database had gone. Readiness checks the database and the event bus and answers 503
naming the one that failed; liveness still touches nothing, because restarting
does not fix a database that is down. Cameras and the recorder are deliberately
NOT part of readiness: a camera on a customer LAN going offline is routine, and
failing the whole VMS API for it would be an outage this service cannot fix.

**An unset `VE_NATS_URL` is not a fault.** A standalone deployment runs with no
spine and serves its API perfectly. A CONFIGURED bus that is not connected is a
fault, because events are then going nowhere silently.

## Tests

```bash
./backend/vision/run-tests.sh
```

746, offline: a throwaway container from the shipped image, tree mounted
read-only, no network. No live device is touched — every network boundary is
monkeypatched with fabricated fixtures (SOAP shapes, ISAPI XML, Dahua CGI text,
Lumina JSON).

There was no runner until recently. 44 files of tests existed and nothing could
execute them, so nobody could see that three of them had been failing: a
`RecordingConfigBody` gained `storage_pool_id` and `NvrClient.start_recording`
gained `record_dir`, and the test doubles never followed. Those doubles are now
pinned to the real signatures with `inspect.signature`, so the next field to
arrive fails one line rather than three assertions that look unrelated.

`test_route_inventory.py` calls all ~204 non-public routes and requires 401 from
each. The static check that a gate is declared is a different question from
whether it answers.

**The ONVIF responder's own auth is tested through the route, not only through the
helper.** Its WS-Security UsernameToken handling had five thorough tests —
PasswordText, PasswordDigest, wrong password, absent token, disabled config — and
every one of them called `authenticate` and `handle_soap` itself, in the order the
route composes them. So the LOGIC was covered and the WIRING was not: removing the
route's enforcement of what `authenticate` returned left all five passing, on six
endpoints that take no JWT and are reachable from the internet. Two tests now go
through the real HTTP endpoint, and they are the ones that fail when it does.

## Known gaps

* Camera and recorder reachability are reported, not alerted on, from here.

## Configuration

`VE_DATABASE_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, `VE_SECRETS_KEY`, `VE_NVR_URL`,
`VE_MEDIA_TOKEN_TTL_SEC`, `VE_RECORDINGS_DIR`, `VE_RETENTION_TICK_SEC`,
`VE_DEFAULT_RETENTION_DAYS`.
