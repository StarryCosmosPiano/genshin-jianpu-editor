import type { MidiInputDevice } from "./midi-input";

export type MidiInputDeviceRole = "yuanqin-input" | "yuanqin-internal" | "other";

/** Only this known loopback pair has a verified application-level direction. */
export function midiInputDeviceRole(device: Pick<MidiInputDevice, "name">): MidiInputDeviceRole {
  const name = device.name.trim().toLowerCase();
  if (name === "yuanqin midi out") return "yuanqin-input";
  if (name === "yuanqin midi send") return "yuanqin-internal";
  return "other";
}

export function midiInputDeviceLabel(device: Pick<MidiInputDevice, "name">): string {
  switch (midiInputDeviceRole(device)) {
    case "yuanqin-input": return `原琴助手演奏输入 · ${device.name}`;
    case "yuanqin-internal": return `原琴助手内部发送端 · ${device.name}`;
    default: return device.name;
  }
}

const roleOrder: Readonly<Record<MidiInputDeviceRole, number>> = {
  "yuanqin-input": 0,
  other: 1,
  "yuanqin-internal": 2,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Retain every port; sort a copy consistently across enumeration order and locale. */
export function sortMidiInputDevices<T extends MidiInputDevice>(devices: readonly T[]): T[] {
  return [...devices].sort((a, b) =>
    roleOrder[midiInputDeviceRole(a)] - roleOrder[midiInputDeviceRole(b)]
    || compareText(a.name.trim().toLowerCase(), b.name.trim().toLowerCase())
    || compareText(a.id, b.id)
    || compareText(a.name, b.name));
}

/** Preserve explicit choices, including Send; never recommend only an internal sender. */
export function defaultMidiInputDeviceId(
  devices: readonly MidiInputDevice[],
  selectedDeviceId: string | null = null,
): string | null {
  if (selectedDeviceId !== null && devices.some(device => device.id === selectedDeviceId)) return selectedDeviceId;
  return sortMidiInputDevices(devices).find(device => midiInputDeviceRole(device) !== "yuanqin-internal")?.id ?? null;
}
