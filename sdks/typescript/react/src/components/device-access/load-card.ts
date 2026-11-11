/** The one place that downloads the card code, so the store and the lazy wrapper share the same import. */
export const loadDeviceAccessCard = () => import("./DeviceAccessCard");
