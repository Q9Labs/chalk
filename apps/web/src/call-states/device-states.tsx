import { Live } from "./live";
import { PEOPLE, liveSnapshot, type Person } from "./fixtures";
import type { CallState } from "./states";

const [nora, akash, sofia, malik, priya, eli] = PEOPLE as readonly [Person, Person, Person, Person, Person, Person];

export const DEVICE_STATES: readonly CallState[] = [
  {
    id: "devices",
    title: "Phones, tablets and a foldable show their device; computers show none",
    render: () => (
      <Live
        snapshot={liveSnapshot({
          self: { device: "mac" },
          others: [
            { ...nora, device: "iphone" },
            { ...akash, device: "ipad" },
            { ...sofia, device: "windows" },
            { ...malik, device: "android_tablet" },
            { ...priya, device: "android_foldable" },
            { ...eli, device: "android_phone" },
          ],
        })}
        layout="grid"
      />
    ),
  },
];
