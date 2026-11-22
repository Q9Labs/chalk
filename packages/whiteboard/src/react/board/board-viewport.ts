import { useMediaQuery } from "./useMediaQuery";

export function useBoardViewport(phoneOverride: boolean | undefined, presentation: "mobile" | "web") {
  const smallViewport = useMediaQuery("(max-width: 640px)");
  const phone = phoneOverride ?? smallViewport;
  const touch = useMediaQuery("(pointer: coarse)") || phone || presentation === "mobile";
  return { phone, touch };
}
