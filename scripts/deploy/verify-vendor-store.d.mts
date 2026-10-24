export function vendorProbe(target: "production" | "nightly"): { bytes: Buffer; keys: string[] };
export function verifyVendorStore(target: "production" | "nightly", origin?: string): Promise<void>;
