import { mountCallStates } from "./mount";
import { PERFORMANCE_STATES } from "./performance";

// Keep catalogue-only fixture data out of the call performance entry.
mountCallStates(PERFORMANCE_STATES);
