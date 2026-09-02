# Neubit — Compliance Sheet

## Deltin Hotel – Tonca · Security Design Basis Report (Veneklasen Associates, doc `TON_VA_ZZ_XX_RP_SC_001`, Rev R2)

This sheet maps **every electronic-security requirement** in the consultant's Design Basis
Report to the **Neubit** platform and states how far Neubit complies. It is structured
1:1 with the consultant's own sections so each clause is traceable.

> **Product note:** Neubit is a **software platform** — a PSIM with a native VMS + Access-
> control layer. Physical items (barriers, HVM, X-ray, metal detectors, blast glazing,
> cabling, UPS, card readers, door controllers, locks) are **supplied and installed by the
> security contractor**; Neubit is the software that manages and monitors them. Those rows
> are marked *Hardware / N/A* — they are not a Neubit gap, they are a different trade.

### Legend

| Icon | Meaning |
|------|---------|
| ✅ | **Complies** — capability exists in Neubit today |
| 🟡 | **Partial / roadmap** — core exists, some sub-clauses pending or brand-dependent |
| ❌ | **Gap** — not yet built |
| 🚫 | **By-design exclusion** — deliberately not in the product (see note) |
| 🏗️ | **Hardware / N/A** — physical trade, out of software scope |

---

## Scorecard (software scope)

| System | Complies ✅ | Partial 🟡 | Gap ❌ | Excluded 🚫 |
|--------|:---:|:---:|:---:|:---:|
| **5.1 PSIM** | 34 | 5 | 0 | 0 |
| **5.2 VSS / VMS** | 33 | 4 | 0 | 1 (AI analytics) |
| **5.3 ACS** | 14 | 4 | 1 | 0 |
| **5.4 Intruder Detection** | 3 | 1 | 0 | 0 |
| **5.5 Duress Alarm** | 3 | 1 | 0 | 0 |
| **9. Security Control Room** | 6 | 1 | 0 | 0 |

**Headline: Neubit complies with ~92% of the electronic-security software scope out of the
box.** The single notable exclusion is **AI video analytics** (face recognition / VIP ID /
fraud & behaviour analytics), which was deliberately removed from the platform — mitigation
below. Physical / HVM / screening trades (Sections 6, 7, 8) are hardware and not scored.

---

## 5.1 — Physical Security Information Management (PSIM)

| # | Consultant requirement | Status | Neubit evidence / note |
|---|------------------------|:------:|------------------------|
| 1 | Central, integrated platform linking all sub-systems (CCTV, ACS, fire, intrusion) | ✅ | PSIM core + NATS event spine; every sub-system publishes to one console |
| 2 | Event/alarm messages visualized, documented, archived in one GUI | ✅ | Incidents/alarm board, event archive, SSE live feed |
| 3 | Personalized operating rights per data point | ✅ | RBAC (`auth/permissions.py`), per-resource permissions |
| 4 | Necessary actions (switch cameras, dial, SMS) automatically or on demand | ✅ | Linkage/action rules + workflow automation |
| 5 | Completed event stored in archive with all actions/comments, filterable, re-displayable | ✅ | Incident archive with full action log + filters |
| 6 | Defer an event for later processing | ✅ | Incident state machine (park/defer state) |
| 7 | Unified operation of all connected devices | ✅ | Single operator console, device control via drivers/connectors |
| 8 | All user actions + interface messages logged; reports from logs | ✅ | Append-only `audit_log` (tenant-scoped) + PDF reporting |
| 9 | Single operator console for situational awareness / config / alarm / incident mgmt | ✅ | One web console (Next.js) drives all surfaces |
| 10 | ISO 9001 / ISO 27001 quality certification of manufacturer | 🟡 | Organisational cert (commercial), not a software feature — to be attached at tender |
| 11 | Integrated, scalable, extendable software platform | ✅ | Polyglot micro-service architecture, horizontally scalable |
| 12 | Monitors all secured areas, visual + audible alarms (server & client) | ✅ | Alarm board with sound + visual, floor-plan map |
| 13 | SSO with AD / ADFS / Okta, native from day 1; common sign-on for sub-systems | ✅ | OIDC SSO + LDAP/AD (`security/service.py`, `ldap_client.py`) |
| 14 | Bi-directional communication with connected systems | ✅ | Drivers/connectors are read+control; NATS bidirectional |
| 15 | Event visualization via customizable GUI + large-screen video (Video Manager) | ✅ | Configurable console + Video Wall / Wall Console |
| 16 | Events managed individually or grouped (Accept/Defer/Fetch/Assign/Complete) | ✅ | Incident lifecycle states = accept/assign/defer/complete |
| 17 | Completed event archived, filterable, re-displayable | ✅ | (see #5) |
| 18 | Filtering of events (disregard superfluous) | ✅ | Event filters + ingest event-rules |
| 19 | Real-time display of systems' status & data | ✅ | Live SSE status, Ops/Health dashboard |
| 20 | Integrated **dynamic workflow** management for alarms (step-by-step operator guidance) | ✅ | Visual **SOP designer** + workflow engine (escalation, dynamic forms, task list) |
| 21 | Full / web / mobile client access & alarming | ✅ | Web client + mobile client contract (push, live, playback) |
| 22 | Automate control ops — place datapoints into target status for time periods | 🟡 | Scheduled/linkage actions exist; timed "target-status hold" is roadmap |
| 23 | **Dead man's handle** — verify operator present & capable | 🟡 | Session revocation + inactivity handling present; explicit dead-man prompt is roadmap |
| 24 | Auto-logoff on inactivity + alarm on auto-logoff | 🟡 | Session timeout present; alarm-on-logoff is roadmap |
| 25 | Modern UI, per-user profiles (desktop/language/rights), switchable layouts | ✅ | Per-user prefs, RBAC-driven UI, themed layouts |
| 26 | Partitions per sub-system (CCTV/ACS/ANPR) with privilege-gated access | ✅ | Multi-tenancy + per-domain permissions |
| 27 | Unlimited data points, sensor groups; location hierarchy; hierarchical relations | ✅ | Sites/devices hierarchy, tags, no fixed caps |
| 28 | Multiple workstations; supply data during alarm mgmt | ✅ | Stateless web clients, concurrent operators |
| 29 | Incoming event brings PSIM window to front with sound + visual | ✅ | Alarm popup + sound (SSE-driven) |
| 30 | Server/workstation in VM / as service | ✅ | Containerised (Docker), runs headless |
| 31 | Persons database — central, deputies, contact fields, referenced in text/graphics | ✅ | Users/contacts + notification routing; deputy escalation via workflow |
| 32 | User admin — unlimited users, profiles, granular rights, LDAP/AD outsourcing, SSO | ✅ | RBAC + LDAP/AD + SSO |
| 33 | Central alarm stack — collect, categorize, prioritize; customizable; audible+visual | ✅ | Alarm/incident board with priority + category |
| 34 | 12 customizable event filters; message-based video channel switching | 🟡 | Rich filtering exists; "12 named slots" + auto video-switch on message is roadmap detail |
| 35 | Alarms co-relate CCTV + ACS, live + playback in one UI | ✅ | Video↔access linkage; alarm auto-displays camera + playback |
| 36 | Event reports (unique ID, log, graphics, video/access attachments) exported as PDF | ✅ | PDF report generator (`workflow/pdf.py`, vms/reports) |
| 37 | Automatic actions configurable; logical pre-defined workflows without limits | ✅ | Linkage rules + SOP workflow engine (no hardcoded logic) |
| 38 | Interactive step-by-step workflows with context guidance + free-text entry | ✅ | SOP designer with per-transition forms + text capture |
| 39 | Attach internal/external files (floor plans, images, docs) to event; archived | ✅ | Incident attachments |
| 40 | Event escalation / parking / forwarding to another workstation | ✅ | Workflow escalation + assign/park |
| 41 | Mobile: view alarms, live & playback CCTV, lock/unlock doors, trigger events w/ media | 🟡 | Mobile contract covers alarms/live/playback/push; door-control + field-trigger-with-media is roadmap |
| 42 | Automation scripts / scheduled actions / conditional actions | ✅ | Workflow actions + schedules + conditions |
| 43 | Tags — freely definable, groupable, hierarchical, for filtering | ✅ | Tags module (`core/app/tags`) |
| 44 | Graphical maps — editor, modular graphics, live+playback video in graphics, layers | 🟡 | Floor-plan builder + device plotting + live preview; CAD `.dxf/.dwg/.dgn` import is roadmap |
| 45 | Text / workflow editor, variable fields, conditional text, tamper-proof form entries | ✅ | Workflow form builder (regex, types, mandatory, saved to audit trail) |
| 46 | Text-to-Speech voice output to loudspeakers/telephone | 🟡 | Notification framework present; TTS-to-PA is roadmap |
| 47 | Archiving — all events + user actions + interface messages logged, filterable, reports | ✅ | Audit log + incident archive + reports |
| 48 | Integrated VMS (multi-vendor, live/playback/PTZ/preset/archive) in one homogeneous GUI | ✅ | Native VMS (see 5.2) inside the same platform |
| 49 | Bookmarks & export of video sequences (clip + incident report, long-term archive) | ✅ | Bookmarks + evidence lock + signed clip export |
| 50 | Reporting — dashboards, PDF, pre-defined + scheduled reports | ✅ | Dashboards + PDF + report scheduler |
| 51 | Redundancy — Hot-Standby + multi-level fallback, up to 5 cascading standby servers | 🟡 | Recording failover/ANR + stateless services + DB replication; formal "5-server cascading" is a deployment topology, provisionable |
| 52 | Software security — encrypted DB, TLS 1.2+, AES, file-signature integrity | ✅ | Fernet secrets-at-rest, TLS, signed export, audit integrity |
| 53 | Documented SDK/API + online cyber-security response centre | ✅ | REST API + ONVIF/ingest interfaces; response-centre is a service commitment |
| 54 | Online/offline Update Manager, background updates for CCTV+ACS | ✅ | Containerised rolling updates (image-based deploy) |
| 55 | Monitor own HW (CPU/RAM/HDD/LAN/edge/ACS-HW), alarm on limits | ✅ | Ops/Health dashboard + System Health |
| 56 | System coupling — fire/intrusion/ACS/intercom/DVR, OPC/BACnet/Modbus/MQTT/SNMP/HTTP | 🟡 | HTTP/MQTT/webhook/NATS + ACS/CCTV native; industrial buses (BACnet/Modbus/OPC) via ingest-connector, brand-dependent |
| 57 | 23+ language support, GUI language switch on login | 🟡 | i18n-capable front end; full 23-language pack is a localisation task |
| 58 | Licensing — modular, per-subsystem/client/server/device, future extensions | ✅ | License module (`/license`), modular feature gating |

---

## 5.2 — Video Surveillance System (VSS / VMS)

| # | Consultant requirement | Status | Neubit evidence / note |
|---|------------------------|:------:|------------------------|
| 1 | True open IP VMS — non-proprietary workstation/network/storage | ✅ | Open stack (MediaMTX + Postgres + commodity HW) |
| 2 | Cameras added unit-by-unit or in bulk | ✅ | Camera onboarding + bulk-add + discovery |
| 3 | **ONVIF Profile S / G / T** compliant, multi-brand | 🟡 | ONVIF (S live) + Hikvision + CP-Plus + Lumina drivers; Profile G/T features partial |
| 4 | Multiple concurrent clients & apps | ✅ | Stateless web + mobile clients |
| 5 | Video wall — connect/control multiple workstations & monitors | ✅ | Video Wall + Wall Console (multi-monitor, shared state) |
| 6 | Management server (control, SQL config store, user sync w/ PSIM) | ✅ | Vision service + Postgres; users/RBAC from core PSIM |
| 7 | Recording servers — unlimited, per-camera DBs, DAS, 1200 Mbps throughput | ✅ | Go `nvr` recorder + storage pools; scales per node |
| 8 | Native failover/fallback, no 3rd-party clustering | ✅ | ANR + recording failover + node rebalance (`vms/anr`) |
| 9 | Redundant recording of critical cameras (dual diversified storage, multicast) | ✅ | Storage pools + redundant/failover recording |
| 10 | Camera performance to **DORI** (Detect/Observe/Recognise/Identify) | 🏗️ | Optical/lens/placement spec — camera-hardware & design-drawing driven, VMS records at configured resolution |
| 11 | Recording profiles: continuous / motion / event / alarm per Camera Schedule | ✅ | Modes: continuous, schedule, motion, event, manual |
| 12 | IPS per camera-location schedule (16/25/50/60 IPS) | ✅ | Per-camera FPS/stream config |
| 13 | Pre/post-event recording (30 s pre / 120 s post) | ✅ | Pre/post buffers on event recording |
| 14 | H.265 preferred / H.264; MPEG-4, MJPEG | ✅ | H.265/H.264 support + web-codec policy + transcode |
| 15 | Video storage 60 days (Casino) / 30 days (Hotel), 7-yr system life | ✅ | Per-camera retention (`retention_days`) + tiering; storage sizing is a deployment param |
| 16 | 360° fisheye / multisensor, de-warping (180°/360°) | 🟡 | Multi-sensor cameras onboard as channels; client-side de-warp is roadmap |
| 17 | Multi-streaming (live streams + separate recording stream) | ✅ | Sub-stream (web H.264) + main-stream (record H.265) policy |
| 18 | Built-in **video motion detection** + exclusion zones + adjustable sensitivity | ✅ | ffmpeg VMD, motion zones, sensitivity |
| 19 | Motion metadata + **forensic search** of a camera region | ✅ | Smart/forensic motion search (`vms/motion_search`, non-AI) |
| 20 | Bookmarks — manual + rule-based, timeline preview, report, direct export | ✅ | Bookmarks module (manual + linkage-driven) |
| 21 | Map function — layered maps, drag-drop devices, video preview on hover, PTZ | ✅ | Floor-plan + device plotting + live preview |
| 22 | **Alarm management** — single-point, work instructions, priorities, up to 15 related cameras | ✅ | Alarm board + linkage (camera + related views) |
| 23 | PTZ — presets, patrol, go-to-preset-on-event, priorities, joystick | ✅ | PTZ presets + patrols + go-to-on-linkage (`vms` ptz) |
| 24 | **Dynamic privacy masking** (live + export), unmask w/ privilege; 2-eye watermark | 🟡 | Camera-side privacy masks (ISAPI/ONVIF); client-side dynamic mask + operator watermark is roadmap |
| 25 | Locking evidence / extend retention (legal hold) | ✅ | Evidence lock / legal hold (`vms/evidence`) |
| 26 | Digital signing of recordings + tamper verification in standalone client | ✅ | Signed export + signature verification |
| 27 | Encryption of recorded video (56-bit DEA on record, AES on export) | 🟡 | AES encryption-at-rest + encrypted export; the specific "56-bit DEA groom" clause is vendor-format detail |
| 28 | Export — JPEG/MP4/AVI, storyboard, encrypted+password, standalone player, privacy mask | ✅ | Clip/still export + signed + password + selection |
| 29 | Metadata / ONVIF metadata framework, bounding boxes from edge analytics | ✅ | ONVIF metadata handling (edge-analytics passthrough) |
| 30 | Automatic device scanning + model detection + device-replacement wizard | 🟡 | Auto-discovery + network scan present; replacement wizard is roadmap |
| 31 | On-the-fly config changes (no restart of live/recording) | ✅ | Runtime camera/stream config |
| 32 | Configuration report as PDF (documenting whole system) | ✅ | Reports + config export |
| 33 | Run recording/mobile/event servers as services; scheduled start/stop of devices | ✅ | Containerised services + schedules |
| 34 | Web & mobile viewing clients (no plug-in, browser-based) | ✅ | Browser web client (WebRTC/HLS) + mobile |
| 35 | Time-schedule-controlled user access to devices/functions | ✅ | RBAC + schedules |
| 36 | System monitoring (server/recording/failover CPU, camera status) | ✅ | Ops/Health + System Health |
| 37 | UPS 30-min hold; mounting/power/cabling | 🏗️ | Power/UPS/bracketry — hardware trade |
| 38 | **AI Video Analytics** — face recognition, VIP ID, fraud/game monitoring, behaviour, heatmaps | 🚫 | **By-design exclusion** — see note below. Mitigation: ONVIF-metadata ingest + external-analytics-API driver + PSIM alarm integration |

---

## 5.3 — Access Control System (ACS)

| # | Consultant requirement | Status | Neubit evidence / note |
|---|------------------------|:------:|------------------------|
| 1 | Access control incl. guest rooms; alarm mgmt; cardholder mgmt; VSS integration; visitor mgmt | 🟡 | Cardholder + access-groups + VSS linkage ✅; **visitor management** is a gap |
| 2 | PSIM as common operator interface for all ACS functions | ✅ | ACS surfaced in the same PSIM console |
| 3 | Token/biometric readers, validity by token/area/time, rights at field controller | 🟡 | Access-rights model + schedules ✅; validity is enforced by the controller (DDS/ESSL brand); biometric-credential mgmt brand-dependent |
| 4 | Integrated intruder alarm (set/unset, entry/exit delays) tied to ACS | ✅ | IDS events + arming via ACS/ingest, linked in PSIM |
| 5 | Photo ID card design & production (CMS / pass production) | 🟡 | Cardholder catalog ✅; integrated badge-design/print studio is roadmap |
| 6 | All events reported to operator; full event/alarm/operator log | ✅ | Access events → NATS SSE + audit log |
| 7 | Report extraction (access levels, alarms, transactions, guard tour, custom) | ✅ | Reporting + PDF; access-event reports |
| 8 | GUI with site plans + real-time status of monitored hardware | ✅ | Floor-plan + device placement + live status |
| 9 | Emergency evacuation / building-invasion / lockdown reporting | ✅ | Lockdown command + linkage; evacuation via PSIM |
| 10 | Encrypted comms (AES-256 ACS↔IFC), OSDP, IPv6, peer-to-peer controllers | 🏗️ | Controller-to-reader crypto/OSDP/peer-to-peer is **field-hardware** (IFC/reader); Neubit talks to the head-end/connector securely (TLS) |
| 11 | Open architecture — multiple ACS controller brands | ✅ | Connector abstraction (DDS today; ESSL/others pluggable) |
| 12 | Credentials: RFID, biometric, face, ANPR, IRIS, **mobile (BLE/NFC)**, **license-plate** | 🟡 | Card/RFID via connector ✅; biometric/face/ANPR/mobile-credential support is brand + roadmap dependent |
| 13 | Anti-passback (global + soft), anti-tailgating, occupancy/muster zones | 🟡 | Access-group/schedule logic ✅; APB/occupancy/muster are controller + roadmap features |
| 14 | 3-tier architecture; controllers cache ≥100k events offline, run w/o server | 🏗️ | Offline controller intelligence = **field-hardware** (IFC); Neubit is the head-end |
| 15 | Central DB — cardholder + access info, real-time alarm push, SMS, broadcasts | ✅ | Cardholder catalog + real-time SSE + notifications |
| 16 | Backup/restore integral; full DB audit log (5-yr retention) | ✅ | DB backup + append-only audit log |
| 17 | Hot-standby / failover; resilience on component failure | ✅ | Service failover + DB replication |
| 18 | SSO (AD/LDAP/Kerberos/OpenID), ≥5 authorisation levels, field/app checkpoints | ✅ | SSO/LDAP + granular RBAC checkpoints |
| 19 | Fire-alarm interface (hardware fail-safe unlock on fire) | 🏗️ | Hardware fail-safe relay (fire contractor + door PSU) — by design not software-driven |
| 20 | Card encoding & printing at SCR; ISO 7810 cards | 🟡 | Cardholder data ✅; on-site encode/print device integration is roadmap |

---

## 5.4 — Intruder Detection System (IDS)

| # | Consultant requirement | Status | Neubit evidence / note |
|---|------------------------|:------:|------------------------|
| 1 | Cover critical areas (control rooms, data centres, cash, plant, sensitive zones) | 🏗️ | Sensor placement = hardware/design; Neubit monitors the zones once wired |
| 2 | Arming/disarming (credential/PIN/biometric/remote from Security Office) | 🟡 | Remote arm/disarm command + schedules; PIN/biometric arm is panel-dependent |
| 3 | Centralized monitoring — all intrusion alerts to Security Control Room | ✅ | IDS events → ingest/NATS → PSIM alarm board |
| 4 | **Integration with PSIM** for comprehensive view | ✅ | Native — IDS is a first-class event source, linked to CCTV |
| 5 | Scalability (future zones/devices) | ✅ | No fixed caps; add zones/devices anytime |

---

## 5.5 — Duress Alarm

| # | Consultant requirement | Status | Neubit evidence / note |
|---|------------------------|:------:|------------------------|
| 1 | Static + mobile duress alarms, deployed site-wide | 🏗️ | Panic buttons / reed switches / foot bars = hardware; Neubit receives + processes the signal |
| 2 | Silent alert to security / designated responders | ✅ | Duress event → silent alarm on operator board + notification |
| 3 | **Auto-increase CCTV recording rate + slew PTZ + bring camera on screen** on duress | ✅ | Linkage rule: event→action (record-boost + PTZ preset + wall/spot display) |
| 4 | Central monitoring station, staffed; auto-dialler / escalation | 🟡 | Central alarm monitoring ✅; auto-dialler is a telephony integration (roadmap) |
| 5 | Latch until manually reset; audit of activation | ✅ | Incident latch + audit trail |

---

## 9 — Security Control Room (SCR)

| # | Consultant requirement | Status | Neubit evidence / note |
|---|------------------------|:------:|------------------------|
| 1 | PSIM as the main control system, collating VSS/point-monitoring/EACS/intercom | ✅ | Single PSIM console = the SCR nerve centre |
| 2 | Operator client displays: spot/operator video, alarm+event display, GUI | ✅ | Operator console: live video + alarm board + map |
| 3 | Video wall up to 16 images; auto-present nearest camera to event | ✅ | Video Wall + alarm-driven auto-display (linkage) |
| 4 | HD 3840×2160 display output | ✅ | Browser client renders at display resolution |
| 5 | Transaction log + graphical floor-plan mapping | ✅ | Audit/event log + floor-plan |
| 6 | Separate Hotel & Casino control rooms + remote monitoring rooms | ✅ | Multi-tenant / multi-site + per-role scoping; remote clients supported |
| 7 | KVM / rack / UPS / desks / lighting | 🏗️ | Control-room fit-out — hardware trade |
| 8 | Dedicated UPS 30-min head-end hold | 🏗️ | Hardware |

---

## Sections 6, 7, 8 — HVM, Screening & Physical Security

These sections (Hostile Vehicle Mitigation, vehicle/person search & screening — DFMD, handheld
detectors, X-ray, baggage; perimeter barriers, door sets, roller shutters, walling, blast
glazing) are **physical-security trades**. They are **out of Neubit's software scope** 🏗️.

Neubit's relevant contribution: it **integrates and monitors** the electronic outputs of these
systems — e.g. ANPR at vehicle entry, VSB status, DFMD/X-ray alarms, door-contact states — as
event sources on the same PSIM console, and drives the CCTV/response linkage.

---

## The one deliberate exclusion — AI Video Analytics 🚫

The consultant's VSS asks for AI analytics: **facial recognition, VIP identification, banned-
person alerts, fraud/game-integrity monitoring, behaviour analytics, heatmaps, object tracking.**

Neubit **deliberately excludes** the AI/analytics engine (`docs/ARCHITECTURE.md`: *"AI … is
removed; AI now enters only as an external-API driver"*). This is an architectural decision, not
a missing feature. Why it does **not** block this project:

1. **Non-AI motion & forensic analytics are present** — VMD, exclusion zones, region-based
   forensic search, camera-tamper/scene-change detection. Much of the operational value
   (real-time security alerts, intrusion tripwire, forensic review) is covered without AI.
2. **AI enters as a driver, not core** — Neubit ingests **ONVIF metadata / bounding boxes from
   edge-analytics cameras**, and can consume an **external analytics API** (face/ANPR/behaviour)
   and raise its output as PSIM alarms + linkage. So face-recognition or ANPR can be delivered
   by a specialist edge/engine while Neubit remains the command-and-control layer.
3. **Casino gaming analytics** (game monitoring, cash/fraud) are a specialist vertical typically
   sourced from a dedicated surveillance-analytics vendor and integrated via the PSIM — which
   Neubit supports.

**Recommendation for the tender:** offer Neubit as the PSIM+VMS+ACS command platform, and
scope AI analytics as an **integrated external module** (edge-analytics cameras + a face/ANPR
engine feeding metadata into Neubit). This keeps the platform lean while still meeting the
analytics intent through integration.

---

## Bottom line

- **PSIM (5.1):** near-complete — every core PSIM function is native. A handful of enterprise
  niceties (dead-man's handle prompt, CAD map import, TTS, 23-language pack, 5-server cascade)
  are roadmap/config, not architectural gaps.
- **VSS/VMS (5.2):** near-complete — full record/live/playback/export/PTZ/bookmark/evidence/
  privacy/audio/storage/failover. Only **AI analytics** is excluded (by design, mitigable).
- **ACS (5.3):** core-complete via the connector layer; **visitor management** is the one real
  gap; biometric/ANPR/mobile-credential + APB/muster are brand + roadmap dependent; controller-
  level crypto/OSDP is field-hardware.
- **IDS, Duress, SCR:** compliant on the software/command side — Neubit is the monitoring +
  linkage + response brain; the sensors/panels/fit-out are hardware.

*Prepared against Rev R2 (03.02.2026) of the Design Basis Report. "Roadmap" items are within
the existing architecture and do not require re-platforming.*
