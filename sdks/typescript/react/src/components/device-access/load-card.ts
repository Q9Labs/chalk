/** The one place that downloads the card chunk, which also carries the resolver, so the store and the lazy wrapper share the same import. */
export const loadDeviceAccessCard = () => import("./DeviceAccessCard");
