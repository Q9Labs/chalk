// Test-only control for the bounded synthetic publisher experiment.
export function controlCamera(sender) {
  const write = sender.setParameters.bind(sender);
  let limited = false;
  sender.setParameters = async (parameters) => {
    if (limited) {
      for (const encoding of parameters.encodings) {
        encoding.active = encoding.rid === "l";
        encoding.maxBitrate = 80000;
      }
    }
    await write(parameters);
  };
  return async (next) => {
    limited = next;
    const parameters = sender.getParameters();
    for (const encoding of parameters.encodings) {
      encoding.active = true;
      encoding.maxBitrate = { h: 2500000, l: 650000 }[encoding.rid];
    }
    await sender.setParameters(parameters);
  };
}
