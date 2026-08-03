// @ts-check

import { check, generate, proof } from "./proof.mjs";

const command = process.argv[2];

try {
  if (command === "generate") {
    const result = await generate();
    console.log(`Generated ${result.path} (${result.bytes} bytes, sha256 ${result.sha256})`);
  } else if (command === "check") {
    const result = await check();
    console.log(`Generated ContractIR is current (${result.bytes} bytes, sha256 ${result.sha256})`);
  } else if (command === "proof") {
    const result = await proof();
    console.log(`Frontend proof passed: ${result.recommendation}`);
    console.log(`IR: ${result.irPath}`);
    console.log(`Report: ${result.reportPath}`);
  } else {
    console.error("Usage: node src/cli.mjs <proof|generate|check>");
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
