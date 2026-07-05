import type { ReactNode } from "react";

export interface SharedPictureInPictureValue {
  isSupported: boolean;
  isOpen: boolean;
  isActive: boolean;
  phase: string | null;
  register: (...args: any[]) => void;
  open: (...args: any[]) => Promise<void>;
  close: (...args: any[]) => Promise<void>;
  toggle: (...args: any[]) => Promise<void>;
}
const value: SharedPictureInPictureValue = { isSupported: false, isOpen: false, isActive: false, phase: null, register: () => {}, open: async () => {}, close: async () => {}, toggle: async () => {} };
export function SharedPictureInPictureProvider({ children }: { enabled?: boolean; children: ReactNode }) {
  return <>{children}</>;
}
export function useSharedPictureInPicture(): SharedPictureInPictureValue {
  return value;
}
