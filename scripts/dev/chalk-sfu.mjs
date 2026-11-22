import { containerArguments, containerNames, containerPath, imageName } from "./containers.mjs";
import nodeTable from "../../features/media/sfu/internal/config/node.json" with { type: "json" };

const { control } = nodeTable.ports;
const hostname = "sfu";

export function devAPIIdentity(config) {
  return `spiffe://${config.auth.trustDomain}/environment/${config.auth.environment}/api/orb`;
}

export function chalkSfuAPIEnvironment(config) {
  return {
    CHALK_NEW_SPACE_RECORDING_POLICY: "disabled",
    CHALK_NEW_SPACE_TRANSCRIPTION_POLICY: "disabled",
    CHALK_SFU_ENABLED: "true",
    CHALK_SFU_CAPTURE_ENABLED: "true",
    CHALK_SFU_APPLICATION_ID: "chalk-orb",
    CHALK_SFU_NODES: `orb=https://${hostname}:${control}`,
    CHALK_SFU_SERVER_NAME: hostname,
    CHALK_SFU_CA_FILE: config.identity.caCertificate,
    CHALK_SFU_CLIENT_CERT_FILE: config.identity.apiCertificate,
    CHALK_SFU_CLIENT_KEY_FILE: config.identity.apiKey,
  };
}

export async function startChalkSfu(config, { network, versions, runResource }) {
  const { caCertificate, sfuCertificate, sfuKey } = config.identity;
  const media = config.ports.sfuMedia;
  const { announceIP, bindIP, includeLoopback } = config.sfuMedia;
  const options = { cwd: config.root };
  const chmod = ["chmod", "0644", containerPath(config, sfuKey)];
  await runResource("docker", containerArguments(config, "api", { image: imageName("api", versions), command: chmod }), options, "identity");

  const name = containerNames(config).sfu;
  const image = `${name}:local`;
  await runResource("docker", ["build", "--tag", image, "--file", "infrastructure/sfu/Dockerfile", "features/media/sfu"], options, "sfu");

  const mounts = [
    [caCertificate, "/ca.pem"],
    [sfuCertificate, "/server.pem"],
    [sfuKey, "/server-key.pem"],
  ];
  const env = {
    SFU_CONTROL_ADDR: `:${control}`,
    SFU_UDP_ADDR: `:${media}`,
    SFU_TCP_ADDR: `:${media}`,
    SFU_ANNOUNCE_IPS: announceIP,
    SFU_ICE_LOOPBACK: String(includeLoopback),
    SFU_TLS_CERT_FILE: "/server.pem",
    SFU_TLS_KEY_FILE: "/server-key.pem",
    SFU_CLIENT_CA_FILE: "/ca.pem",
    SFU_CLIENT_IDENTITY: devAPIIdentity(config),
    SFU_NODE_SIZE: "s-2vcpu-2gb",
    SFU_ENVIRONMENT: "local",
  };
  await runResource(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--network",
      network,
      "--network-alias",
      hostname,
      "--cap-drop",
      "ALL",
      "--publish",
      `${bindIP}:${media}:${media}/udp`,
      "--publish",
      `${bindIP}:${media}:${media}/tcp`,
      ...mounts.flatMap(([source, target]) => ["--mount", `type=bind,source=${source},target=${target},readonly`]),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      image,
    ],
    options,
    "sfu",
  );
}
