"use client";

// EVENT ALERTS — the operator's own alert settings, in My account → Preferences
// (SCRUM-326, SCRUM-327). The top bar's Alerts menu holds the two switches an
// operator flips during a shift (sound, pop-ups); this card holds the rest, in the
// three questions an alarm console's client settings answer:
//   * THE POP-UP — whether the Events page opens its alarm window, how long it stays
//     (Milestone's 15 s by default), and whether a critical waits for an answer;
//   * THE SOUND — how loud, which security sound each priority makes (yelp, hi-lo,
//     whoop, warble, horn, bell, wail — built in, so they work air-gapped), and
//     whether it keeps ringing while the pop-up is open;
//   * WHICH EVENTS — the severities that interrupt at all, and the plate reads.
// Saved to the user's preferences, so they follow the operator to any workstation.
import { useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";

import { Card, Select, Toggle } from "@/components/ui/kit";

import { POPUP_CLOSE_OPTIONS, useAlertPrefs, type AlertLevel, type AnprAlertMode } from "../alertPrefs";
import { ALERT_SOUNDS, unlockAlertSound, type AlertSoundId, type AlertTone } from "../alertSound";
import { testAlertTone, useAlertSoundState } from "./EventAlertControl";

const LEVELS: { value: AlertLevel; label: string }[] = [
  { value: "alarm", label: "Alarms and criticals" },
  { value: "critical", label: "Criticals only" },
];

const ANPR_MODES: { value: AnprAlertMode; label: string }[] = [
  { value: "all", label: "Every alerting read" },
  { value: "hits", label: "Block-list hits only" },
  { value: "off", label: "Off — Events list only" },
];

const closeLabel = (sec: number) => {
  if (sec === 0) return "Don't close — I close it";
  return sec < 60 ? `After ${sec} s` : `After ${sec / 60} min`;
};

const CLOSE_AFTER = POPUP_CLOSE_OPTIONS.map((sec) => ({ value: String(sec), label: closeLabel(sec) }));

const SOUND_OPTIONS = ALERT_SOUNDS.map((s) => ({ value: s.id, label: s.label }));

function Row({ title, desc, children }: Readonly<{ title: ReactNode; desc?: ReactNode; children?: ReactNode }>) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-card-border py-3 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {desc && <div className="mt-0.5 text-xs text-muted">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <div className="mt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function PlayButton({ label, disabled, onClick }: Readonly<{ label: string; disabled: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex items-center gap-1 rounded-md border border-card-border px-2 py-1 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground disabled:opacity-40"
    >
      <Icon icon="heroicons-outline:play" className="text-xs" /> Test
    </button>
  );
}

function SoundRow({
  tone,
  title,
  desc,
  value,
  volume,
  disabled,
  onChange,
}: Readonly<{
  tone: AlertTone;
  title: string;
  desc: string;
  value: AlertSoundId;
  volume: number;
  disabled: boolean;
  onChange: (id: AlertSoundId) => void;
}>) {
  return (
    <Row title={title} desc={desc}>
      <div className="flex items-center gap-2">
        <div className="w-48">
          <Select
            ariaLabel={title}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const id = e.target.value as AlertSoundId;
              onChange(id);
              // Picking a sound is asking to hear it.
              void testAlertTone(volume, tone, id);
            }}
            options={SOUND_OPTIONS}
          />
        </div>
        <PlayButton
          label={`Test the ${title.toLowerCase()}`}
          disabled={disabled}
          onClick={() => void testAlertTone(volume, tone, value)}
        />
      </div>
    </Row>
  );
}

export default function EventAlertsCard() {
  const { prefs, save } = useAlertPrefs();
  const sound = useAlertSoundState();
  // The slider moves freely and saves once, on release — not a request per step.
  const [volume, setVolume] = useState<number | null>(null);
  const shown = volume ?? prefs.volume;
  const commitVolume = () => {
    if (volume !== null && volume !== prefs.volume) void save({ volume });
    setVolume(null);
  };

  // Two columns on a wide card — the pop-up and which events on one side, the
  // sound on the other — so the two halves come out about the same height.
  return (
    <Card className="@container p-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">Event alerts</h2>
      <p className="text-xs text-muted">
        Pop-ups and sound for alarms and plate hits, on every page. They apply to every event type and follow you to any
        workstation.
      </p>

      <div className="grid gap-x-10 @4xl:grid-cols-2">
        <div>
          <Group title="Pop-up">
            <Row title="Alert pop-ups" desc="A card with the alarm's picture and details when one arrives.">
              <Toggle checked={prefs.popup} onChange={(v) => void save({ popup: v })} label="Alert pop-ups" />
            </Row>
            <Row
              title="Alarm window on the Events page"
              desc="A large window in the middle of the page with the recording, live view and every detail. Off: a corner card."
            >
              <Toggle
                checked={prefs.popupOnEvents}
                disabled={!prefs.popup}
                onChange={(v) => void save({ popupOnEvents: v })}
                label="Alarm window on the Events page"
              />
            </Row>
            <Row title="Close the pop-up" desc="Counted from the newest alarm; paused while you point at it.">
              <div className="w-48">
                <Select
                  ariaLabel="Close the pop-up"
                  value={String(prefs.popupCloseSec)}
                  disabled={!prefs.popup}
                  onChange={(e) => void save({ popupCloseSec: Number(e.target.value) })}
                  options={CLOSE_AFTER}
                />
              </div>
            </Row>
            <Row title="Criticals stay until answered" desc="A critical's pop-up waits for Acknowledge or Dismiss.">
              <Toggle
                checked={prefs.criticalStays}
                disabled={!prefs.popup}
                onChange={(v) => void save({ criticalStays: v })}
                label="Criticals stay until answered"
              />
            </Row>
          </Group>

          <Group title="Which events">
            <Row title="Alert for" desc="Events below this stay in the Events list, without a pop-up or a tone.">
              <div className="w-48">
                <Select
                  ariaLabel="Alert for"
                  value={prefs.level}
                  onChange={(e) => void save({ level: e.target.value as AlertLevel })}
                  options={LEVELS}
                />
              </div>
            </Row>

            <Row
              title="Plate reads (ANPR)"
              desc="A busy gate reads every vehicle; most sites only want to hear a block-list hit."
            >
              <div className="w-48">
                <Select
                  ariaLabel="Plate reads (ANPR)"
                  value={prefs.anpr}
                  onChange={(e) => void save({ anpr: e.target.value as AnprAlertMode })}
                  options={ANPR_MODES}
                />
              </div>
            </Row>
          </Group>
        </div>

        <div>
          <Group title="Sound">
            <Row title="Alert sound" desc="Security siren tones on every page — one per priority, chosen below.">
              <Toggle
                checked={prefs.sound}
                onChange={(v) => {
                  if (v) void unlockAlertSound();
                  void save({ sound: v });
                }}
                label="Alert sound"
              />
            </Row>

            <Row title="Volume" desc={`${shown}%`}>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={shown}
                  disabled={!prefs.sound}
                  aria-label="Alert volume"
                  onChange={(e) => setVolume(Number(e.target.value))}
                  onPointerUp={commitVolume}
                  onKeyUp={commitVolume}
                  onBlur={commitVolume}
                  className="w-32 accent-nb-blue disabled:opacity-40"
                />
                <PlayButton
                  label="Test the alarm sound at this volume"
                  disabled={!prefs.sound}
                  onClick={() => void testAlertTone(shown, "alarm", prefs.alarmSound)}
                />
              </div>
            </Row>

            <SoundRow
              tone="critical"
              title="Critical sound"
              desc="Block-list hits, tamper, a recorder in trouble."
              value={prefs.criticalSound}
              volume={prefs.volume}
              disabled={!prefs.sound}
              onChange={(id) => void save({ criticalSound: id })}
            />
            <SoundRow
              tone="alarm"
              title="Alarm sound"
              desc="Motion, line crossing, intrusion, plate alerts."
              value={prefs.alarmSound}
              volume={prefs.volume}
              disabled={!prefs.sound}
              onChange={(id) => void save({ alarmSound: id })}
            />
            {prefs.criticalSound === prefs.alarmSound && (
              <p className="border-b border-card-border pb-3 text-[11.5px] text-amber-200">
                Criticals and alarms make the same sound. Pick two different ones to tell them apart by ear.
              </p>
            )}

            <Row
              title="Keep ringing for criticals"
              desc="While its pop-up is open — until it is acknowledged, dismissed or silenced."
            >
              <Toggle
                checked={prefs.repeatCritical}
                disabled={!prefs.sound}
                onChange={(v) => void save({ repeatCritical: v })}
                label="Keep ringing for criticals"
              />
            </Row>
            <Row title="Keep ringing for alarms" desc="While its pop-up is open. Off: one ring per alarm.">
              <Toggle
                checked={prefs.repeatAlarm}
                disabled={!prefs.sound}
                onChange={(v) => void save({ repeatAlarm: v })}
                label="Keep ringing for alarms"
              />
            </Row>
          </Group>
        </div>
      </div>

      {prefs.sound && sound === "blocked" && (
        <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          The browser plays sound only after a click in the console. Any click enables it for this session.
        </p>
      )}
      {sound === "unsupported" && <p className="mt-3 text-xs text-muted">This browser cannot play the alert sound.</p>}
    </Card>
  );
}
