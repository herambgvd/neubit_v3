"use client";

// DEVICE I/O — the one action in this console that moves something in the world.
//
// A relay opens a gate, releases a door, sounds a siren. Every other federated
// command changes a picture or a file; this one changes a building. Three things
// follow from that, and all three are the reason this is a dialog and not a
// switch on a card.
//
// 1. THERE IS NO TOGGLE, because there is no state to toggle. ONVIF provides no
//    way to READ a relay's present position — it is reported only as an event, and
//    the recorder says so in `relay_state_detail` rather than letting a console
//    guess. A switch would render a position we invented, and an operator would
//    read it as "the gate is closed". So the controls are VERBS: set it active,
//    set it inactive. What is shown beside them is how the relay is configured.
//
// 2. THE DEVICE IS NOT THE CAMERA. On a multi-channel encoder one box carries
//    several channels, and a relay belongs to the box. Driving it from Channel 2's
//    page acts on whatever the other channels are wired to as well — so the other
//    channels are NAMED before the button, not discovered afterwards.
//
// 3. MONOSTABLE AND BISTABLE ARE DIFFERENT PROMISES. A monostable relay returns by
//    itself after its delay; a bistable one stays where it is put until somebody
//    puts it back. A device that reported NEITHER gets neither sentence — a null
//    mode means the device did not say, and printing "it will return on its own"
//    from a missing field is how a gate is left open overnight.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Modal, type ConfirmState } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { FederatedIo, FederatedRelay } from "../types";

export interface RelayModalProps {
  nodeId: string;
  cameraId: string;
  cameraName: string;
  onClose?: () => void;
}

/** What happens after a drive, in the operator's terms — and nothing at all when
 *  the device did not report its mode. */
export function relayBehaviour(relay: FederatedRelay): string | null {
  const mode = String(relay.settings?.mode ?? "").toLowerCase();
  const delay = relay.settings?.delay_seconds;
  if (mode === "monostable") {
    return delay ? `returns on its own after ${delay}s` : "returns on its own";
  }
  if (mode === "bistable") return "stays until it is set back";
  // Deliberately nothing. A missing mode is the device not saying, and a guess
  // here is the sentence somebody would act on.
  return null;
}

/** The other channels a drive reaches. Empty when this device carries one camera —
 *  then the warning is noise and is not shown. */
export function sharedChannels(io: FederatedIo | undefined, cameraName: string): string[] {
  const names = (io?.channel_names ?? []).filter((n): n is string => !!n && n !== cameraName);
  return names;
}

export default function RelayModal({ nodeId, cameraId, cameraName, onClose }: Readonly<RelayModalProps>) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const ioQ = useQuery({
    queryKey: ["vms", "federation", "io", nodeId, cameraId],
    queryFn: () => vms.federation.io.get(nodeId, cameraId),
    retry: false,
  });

  const io = ioQ.data;
  const relays: FederatedRelay[] = io?.relay_outputs ?? [];
  const inputs = io?.digital_inputs ?? [];
  const shared = sharedChannels(io, cameraName);

  const drive = useMutation({
    mutationFn: ({ token, state }: { token: string; state: "active" | "inactive" }) =>
      vms.federation.io.setRelay(nodeId, cameraId, token, state),
    onSuccess: (_r, v) => {
      toast.success(`Relay ${v.token} set ${v.state}`, {
        // Said every time, because the console genuinely cannot confirm it: the
        // node accepted the command, and the device reports no position back.
        description: "The recorder accepted the command. The device reports no position to read back.",
      });
      qc.invalidateQueries({ queryKey: ["vms", "federation", "io", nodeId, cameraId] });
    },
    onError: (e) => toast.error(apiError(e, "The relay could not be driven")),
  });

  const ask = (relay: FederatedRelay, state: "active" | "inactive") =>
    setConfirm({
      title: `Set relay ${relay.token} ${state}?`,
      message: (
        <>
          This acts on the device at {io?.device_host || "this camera"}
          {shared.length > 0 && (
            <>
              , which also carries <b>{shared.join(", ")}</b>
            </>
          )}
          . {relayBehaviour(relay) ?? "This device did not report whether the relay returns on its own."}
        </>
      ),
      confirmLabel: `Set ${state}`,
      danger: state === "active",
      onConfirm: () => drive.mutate({ token: relay.token, state }),
    });

  // Named above the JSX rather than chained inside it: three states, and the one a
  // reader is usually looking for — what this shows when the device cannot be read
  // — is the middle of the chain and the easiest to miss.
  let body: React.ReactNode;
  if (ioQ.isLoading) {
    body = <p className="py-6 text-center text-[12.5px] text-nb-faint">Reading the device…</p>;
  } else if (ioQ.isError) {
    body = (
      <p className="py-6 text-center text-[12.5px] text-nb-crit">
        {apiError(ioQ.error, "The recorder could not read this device's I/O")}
      </p>
    );
  } else {
    body = (
          <div className="space-y-3">
            {shared.length > 0 && (
              <p className="rounded-[9px] border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[11.5px] text-amber-200">
                <Icon icon="heroicons:exclamation-triangle" className="mr-1 inline text-xs" />
                This is one device carrying {(io?.channels_on_device ?? shared.length + 1)} channels —{" "}
                {shared.join(", ")} share these relays.
              </p>
            )}

            {!relays.length ? (
              <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-5 text-center text-[12px] text-nb-faint">
                {io?.device_io_supported === false
                  ? "This device offers no Device I/O service, so it reports no relays."
                  : "This device reports no relay outputs."}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {relays.map((relay) => (
                  <li
                    key={relay.token}
                    className="flex flex-wrap items-center gap-2 rounded-[10px] border border-nb-line px-3 py-2.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-nb-text">
                        Relay {relay.token}
                      </span>
                      <span className="block text-[11px] text-nb-faint">
                        idle {relay.settings?.idle_state ?? "unreported"}
                        {relayBehaviour(relay) ? ` · ${relayBehaviour(relay)}` : ""}
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={drive.isPending}
                      onClick={() => ask(relay, "active")}
                      className="rounded-md border border-amber-500/45 bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40"
                    >
                      Set active
                    </button>
                    <button
                      type="button"
                      disabled={drive.isPending}
                      onClick={() => ask(relay, "inactive")}
                      className="rounded-md border border-nb-line px-2.5 py-1.5 text-[12px] text-nb-soft transition hover:text-nb-text disabled:opacity-40"
                    >
                      Set inactive
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* The recorder's own sentence, not a paraphrase. It is the reason
                there are verbs here instead of switches. */}
            {io?.relay_state_detail && (
              <p className="text-[11px] text-nb-faint">{io.relay_state_detail}</p>
            )}

            {inputs.length > 0 && (
              <p className="text-[11.5px] text-nb-soft">
                {inputs.length} digital {inputs.length === 1 ? "input" : "inputs"}.{" "}
                {io?.digital_input_detail}
              </p>
            )}
          </div>
    );
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Device I/O"
        subtitle={`Inputs and relays on the device behind ${cameraName}`}
        footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
      >
        {body}
      </Modal>
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={drive.isPending} />
    </>
  );
}
