import {
  defaultMidiInputDeviceId, midiInputDeviceLabel, midiInputDeviceRole, sortMidiInputDevices,
} from "./src/editor/midi-device-role";
import type { MidiInputDevice } from "./src/editor/midi-input";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

const sender = Object.freeze({ id: "send", name: "YuanQin MIDI Send" });
const performance = Object.freeze({ id: "out", name: "YuanQin MIDI Out" });
const keyboard = Object.freeze({ id: "usb", name: "USB Keyboard" });
const pair = Object.freeze([sender, performance]);

equal(midiInputDeviceRole(performance), "yuanqin-input", "the verified receiving endpoint was not recognized");
equal(midiInputDeviceRole(sender), "yuanqin-internal", "the internal sending endpoint was not distinguished");
equal(midiInputDeviceRole({ name: "  yuanqin midi OUT  " }), "yuanqin-input", "name case or surrounding spaces hid the known endpoint");
equal(midiInputDeviceLabel(performance), "原琴助手演奏输入 · YuanQin MIDI Out", "performance label lost its role or original port name");
equal(midiInputDeviceLabel(sender), "原琴助手内部发送端 · YuanQin MIDI Send", "internal label lost its role or original port name");
equal(sortMidiInputDevices(pair).map(device => device.id), ["out", "send"], "the wrong half of the loopback pair was presented first");
equal(defaultMidiInputDeviceId(pair), "out", "first connection recommended the internal sender");
equal(defaultMidiInputDeviceId([sender, keyboard, performance]), "out", "ordinary hardware displaced the known performance input recommendation");

const ordinaryNames = [
  "USB MIDI In", "USB MIDI Out", "MIDI Send", "MIDI Return", "loopMIDI Port",
  "YuanQin MIDI Outboard", "YuanQin MIDI Sender", "Other YuanQin MIDI Out",
  "YuanQin MIDI Out 2", "YuanQin MIDI Send [1]", "", "  Custom In/Out  ",
];
const ordinaryDevices = ordinaryNames.map((name, index) => ({ id: `ordinary-${index}`, name }));
for (const device of ordinaryDevices) {
  equal(midiInputDeviceRole(device), "other", `unverified device direction was guessed for ${JSON.stringify(device.name)}`);
  equal(midiInputDeviceLabel(device), device.name, "ordinary device names were rewritten");
  equal(defaultMidiInputDeviceId([device]), device.id, "an ordinary or unknown device was excluded from selection");
}
const ordinarySorted = sortMidiInputDevices(ordinaryDevices);
equal(ordinarySorted.length, ordinaryDevices.length, "ordinary devices were hidden");
check(ordinaryDevices.every(device => ordinarySorted.includes(device)), "sorting replaced or dropped original device objects");

equal(defaultMidiInputDeviceId([sender]), null, "an internal sender alone was automatically recommended");
equal(sortMidiInputDevices([sender]), [sender], "an internal sender was hidden from explicit selection");
equal(defaultMidiInputDeviceId([sender], sender.id), sender.id, "an explicit internal sender choice was changed");
equal(defaultMidiInputDeviceId([sender], "gone"), null, "a disappeared selection fell back to an internal sender");
equal(defaultMidiInputDeviceId([]), null, "an empty list produced a selection");
equal(defaultMidiInputDeviceId([], "gone"), null, "an empty list retained a disappeared selection");
equal(sortMidiInputDevices([]), [], "an empty list did not sort safely");
equal(defaultMidiInputDeviceId([sender, keyboard]), keyboard.id, "an ordinary keyboard was not preferred over an internal sender");
equal(defaultMidiInputDeviceId([sender, keyboard, performance], keyboard.id), keyboard.id, "a connected ordinary keyboard was silently changed");
equal(defaultMidiInputDeviceId([sender, keyboard, performance], sender.id), sender.id, "an explicit sender selection was silently changed");
equal(defaultMidiInputDeviceId([sender, keyboard, performance], "gone"), performance.id, "a disappeared selection blocked the performance input recommendation");

const anotherKeyboard = Object.freeze({ id: "usb-2", name: "USB Keyboard" });
const alphaKeyboard = Object.freeze({ id: "alpha", name: "Alpha Keyboard" });
const all = Object.freeze([sender, anotherKeyboard, performance, keyboard, alphaKeyboard]);
const originalIds = all.map(device => device.id);
const expectedIds = ["out", "alpha", "usb", "usb-2", "send"];
function* permutations<T>(values: readonly T[]): Generator<T[]> {
  if (!values.length) { yield []; return; }
  for (let index = 0; index < values.length; index++) {
    for (const rest of permutations([...values.slice(0, index), ...values.slice(index + 1)])) {
      yield [values[index], ...rest];
    }
  }
}
let permutationCount = 0;
for (const ordering of permutations<MidiInputDevice>(all)) {
  const sorted = sortMidiInputDevices(Object.freeze(ordering));
  equal(sorted.map(device => device.id), expectedIds, "enumeration order changed the displayed ordering");
  equal(defaultMidiInputDeviceId(ordering), performance.id, "enumeration order changed the recommended device");
  equal(sortMidiInputDevices(sorted).map(device => device.id), expectedIds, "sorting was not idempotent");
  permutationCount++;
}
equal(permutationCount, 120, "the ordering regression did not exercise every five-device permutation");
equal(all.map(device => device.id), originalIds, "sorting mutated the provider's device list");
equal(pair.map(device => device.id), ["send", "out"], "sorting mutated the original loopback pair");

console.log("MIDI device role checks passed: verified YuanQin pair, ordinary/unknown devices, explicit selection, sender-only fallback and 120 ordering permutations.");
