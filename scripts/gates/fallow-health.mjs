#!/usr/bin/env node
// Fallow's health score, which fails below FALLOW_MIN_SCORE (default 90).
import { runCommand } from "../lib/platform.mjs";

const minimumScore = process.env.FALLOW_MIN_SCORE || "90";
process.exit(runCommand("fallow", ["health", "--score", "--hotspots", "--targets", "--min-score", minimumScore]));
