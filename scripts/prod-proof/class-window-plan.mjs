// Pure arithmetic for a class-window proof: what admission reserves per class, how many SFU nodes a run needs,
// and what the run costs. No network and no browser, so the numbers can be checked before anything is provisioned.
import nodeTable from "../../features/media/sfu/internal/config/node.json" with { type: "json" };

// Defaults from features/media/sfu/internal/config/config.go. class-window.test.mjs reads that file and fails when they drift.
export const costs = { video: 300, cameraUplink: 390, audio: 50, screen: 210, smallTile: 90 };
export const defaults = { cameras: 2, episodePacketCeiling: 11520, largeCallParticipants: 6 };

// DigitalOcean list prices per month for the sizes this proof uses. Hourly is the monthly price over 730 hours; check the
// current price page before a run that will be billed.
export const dropletMonthlyUsd = { "s-1vcpu-1gb": 6, "s-2vcpu-2gb": 18, "s-4vcpu-8gb": 48 };
// The Basic Droplet monthly ceiling is reached after 672 billed hours.
const hoursPerMonth = 672;

/** The packets/s one Episode reserves: the nominal peak in admission.go, capped by the Episode ceiling and the node budget. */
export function classReservation({ participants = 3, cameras = defaults.cameras, screen = true, budget }) {
  if (participants > defaults.largeCallParticipants) throw new Error(`a class of ${participants} is a large call; the small-tile formula is not modeled here`);
  const count = Math.max(participants, 2);
  const uplink = cameras * costs.cameraUplink + costs.audio;
  const downlink = (count - 1) * costs.audio + (count - 1) * cameras * costs.video;
  const shareTerm = screen ? count * (costs.screen + costs.audio) : 0;
  const nominal = count * uplink + count * downlink + shareTerm;
  return Math.min(nominal, defaults.episodePacketCeiling, budget);
}

/** Node sizes from node.json, with the number of classes each admits and the nodes a run of `classes` needs. */
export function nodeOptions({ classes, participants = 3, cameras = defaults.cameras, screen = true }) {
  return Object.entries(nodeTable.sizes).map(([size, { packetBudget }]) => {
    const reservation = classReservation({ participants, cameras, screen, budget: packetBudget });
    const classesPerNode = Math.floor(packetBudget / reservation);
    return {
      size,
      packetBudget,
      classesPerNode,
      reservedPerNodeAtFull: classesPerNode * reservation,
      headroomPackets: packetBudget - classesPerNode * reservation,
      nodesNeeded: classesPerNode > 0 ? Math.ceil(classes / classesPerNode) : Infinity,
    };
  });
}

/** Cost of a run: `droplets` maps a size to a count, `hours` is the whole run including setup and teardown. */
export function runCostUsd({ droplets, hours }) {
  return Object.entries(droplets).reduce((total, [size, count]) => {
    const monthly = dropletMonthlyUsd[size];
    if (monthly === undefined) throw new Error(`no list price for ${size}`);
    return total + count * hours * (monthly / hoursPerMonth);
  }, 0);
}

/** The whole plan for one run. `nodeSize` picks the SFU SKU; the default is production's primary. */
export function planClassWindow({ classes, participants = 3, cameras = defaults.cameras, screen = true, shareDuty = 0.65, nodeSize = "s-2vcpu-2gb", generatorSize = "s-4vcpu-8gb", hours = 3, shards = 1 }) {
  if (!Number.isInteger(classes) || classes < 1) throw new Error("classes must be a positive integer");
  if (!Number.isInteger(shards) || shards < 1) throw new Error("shards must be a positive integer");
  if (!(shareDuty >= 0 && shareDuty <= 1)) throw new Error("shareDuty must be between 0 and 1");
  const options = nodeOptions({ classes, participants, cameras, screen });
  const chosen = options.find((option) => option.size === nodeSize);
  if (!chosen) throw new Error(`${nodeSize} is not a measured SFU size in node.json`);
  const nodes = chosen.nodesNeeded;
  const reservation = classReservation({ participants, cameras, screen, budget: chosen.packetBudget });
  const warnings = [];
  if (chosen.headroomPackets < reservation) warnings.push(`${nodeSize} has ${chosen.headroomPackets} packets/s of headroom, under one class (${reservation}); a class past the last full node is refused with 429 capacity_exceeded`);
  if (nodes * chosen.classesPerNode !== classes) warnings.push(`${nodes} ${nodeSize} nodes admit ${nodes * chosen.classesPerNode} classes, so ${nodes * chosen.classesPerNode - classes} class slots are unused`);
  const droplets = { [nodeSize]: nodes };
  droplets[generatorSize] = (droplets[generatorSize] ?? 0) + shards;
  return {
    classes,
    guests: classes * participants,
    shardsRequested: shards,
    reservationPerClass: reservation,
    nodeSize,
    nodesNeeded: nodes,
    classesPerNode: chosen.classesPerNode,
    headroomPerNode: chosen.headroomPackets,
    shareDuty,
    nodeOptions: options,
    droplets,
    costUsd: Number(runCostUsd({ droplets, hours }).toFixed(2)),
    hours,
    warnings,
  };
}
