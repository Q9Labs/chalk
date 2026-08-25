export type ChalkAdmissionRequest = {
  readonly id: string;
  readonly displayName: string;
  readonly requestedAt?: Date;
};

export type ChalkAdmissionControl = {
  readonly requests: readonly ChalkAdmissionRequest[];
  readonly loading?: boolean;
  readonly admit: (id: string) => Promise<void>;
  readonly deny: (id: string) => Promise<void>;
};
