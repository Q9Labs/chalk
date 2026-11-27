import type { ParticipantDeviceKind } from "../sync/device-kind";
import type { Participant } from "./participant-types";

/** What a participant is on. Only a `form` other than "computer" earns a tile badge. */
export type ParticipantDevice = {
  /** Short, sentence case: "iPhone", "Android tablet", "Mac". */
  readonly label: string;
  /** Completes "Joined from ...": "iPhone", "an Android phone", "a foldable". */
  readonly joinedFrom: string;
  readonly form: "phone" | "tablet" | "foldable" | "computer";
};

const KIND_DEVICES: Readonly<Record<ParticipantDeviceKind, ParticipantDevice>> = {
  iphone: { label: "iPhone", joinedFrom: "iPhone", form: "phone" },
  ipad: { label: "iPad", joinedFrom: "iPad", form: "tablet" },
  android_phone: { label: "Android", joinedFrom: "an Android phone", form: "phone" },
  android_tablet: { label: "Android tablet", joinedFrom: "an Android tablet", form: "tablet" },
  android_foldable: { label: "Foldable", joinedFrom: "a foldable", form: "foldable" },
  mac: { label: "Mac", joinedFrom: "a Mac", form: "computer" },
  windows: { label: "Windows", joinedFrom: "a Windows computer", form: "computer" },
  linux: { label: "Linux", joinedFrom: "a Linux computer", form: "computer" },
  chromeos: { label: "Chromebook", joinedFrom: "a Chromebook", form: "computer" },
};

// A client that declares no device still gets the coarse type Sync derives from its user agent.
const TYPE_DEVICES: Readonly<Record<NonNullable<Participant["deviceType"]>, ParticipantDevice>> = {
  phone: { label: "Phone", joinedFrom: "a phone", form: "phone" },
  tablet: { label: "Tablet", joinedFrom: "a tablet", form: "tablet" },
  computer: { label: "Computer", joinedFrom: "a computer", form: "computer" },
};

/** The device a participant is on, from the kind they declared or else the type Sync derived. */
export function participantDevice(participant: Pick<Participant, "deviceKind" | "deviceType"> | undefined): ParticipantDevice | undefined {
  if (participant?.deviceKind) return KIND_DEVICES[participant.deviceKind];
  return participant?.deviceType ? TYPE_DEVICES[participant.deviceType] : undefined;
}

/** The device's name, with "· 2 devices" when the same person is connected from more than one. */
export function deviceHint(participant: Participant | undefined, roster: readonly Participant[]): string | undefined {
  const label = participantDevice(participant)?.label;
  const devices = participant?.identityId ? roster.filter((item) => item.identityId === participant.identityId && item.presence.state === "connected").length : 0;
  if (devices < 2) return label;
  return `${label ?? "Device"} · ${devices} devices`;
}
