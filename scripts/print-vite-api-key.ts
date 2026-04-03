const apiKey = process.argv[2] ?? "";

if (!apiKey) {
  console.error("Missing API key argument. Pass it as the first CLI argument.");
  process.exitCode = 1;
} else {
  console.log("---- VITE_CHALK_API_KEY ----");
  console.log(apiKey);
}
