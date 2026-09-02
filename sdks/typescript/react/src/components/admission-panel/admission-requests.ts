import { useCallback, useMemo } from "react";

import { useAdmissionControl, useCan, useParticipants, useSpaceClient } from "../../bindings/hooks";

const SYNC_REQUEST_PREFIX = "sync:";
const CONTROL_REQUEST_PREFIX = "control:";

export type CombinedAdmissionRequest = {
  readonly id: string;
  readonly displayName: string;
  readonly joinedAt?: Date;
  readonly source: "sync" | "control";
  readonly sourceId: string;
};

export function useCombinedAdmissionRequests(): {
  readonly requests: readonly CombinedAdmissionRequest[];
  readonly loading: boolean;
  readonly error?: string;
  readonly admit: (id: string) => Promise<void>;
  readonly deny: (id: string) => Promise<void>;
} {
  const client = useSpaceClient();
  const participantsSlice = useParticipants();
  const canManageAdmission = useCan("manageAdmission");
  const admissionControl = useAdmissionControl();

  const requests = useMemo<readonly CombinedAdmissionRequest[]>(() => {
    if (!canManageAdmission) return [];

    const syncRequests: CombinedAdmissionRequest[] = participantsSlice.admissionQueue.map((request) => ({
      id: `${SYNC_REQUEST_PREFIX}${request.requestId}`,
      displayName: request.displayName,
      source: "sync",
      sourceId: request.requestId,
    }));
    const controlledRequests: CombinedAdmissionRequest[] = (admissionControl?.requests ?? []).map((request) => ({
      id: `${CONTROL_REQUEST_PREFIX}${request.id}`,
      displayName: request.displayName,
      joinedAt: request.requestedAt,
      source: "control",
      sourceId: request.id,
    }));

    return [...syncRequests, ...controlledRequests];
  }, [admissionControl?.requests, canManageAdmission, participantsSlice.admissionQueue]);

  const requestById = useMemo(() => new Map(requests.map((request) => [request.id, request])), [requests]);
  const admit = useCallback(
    (id: string): Promise<void> => {
      const request = requestById.get(id);
      if (!request) return Promise.resolve();
      if (request.source === "control") return admissionControl?.admit(request.sourceId) ?? Promise.resolve();
      return client.participants.admit(request.sourceId);
    },
    [admissionControl, client, requestById],
  );
  const deny = useCallback(
    (id: string): Promise<void> => {
      const request = requestById.get(id);
      if (!request) return Promise.resolve();
      if (request.source === "control") return admissionControl?.deny(request.sourceId) ?? Promise.resolve();
      return client.participants.deny(request.sourceId);
    },
    [admissionControl, client, requestById],
  );

  return { requests, loading: admissionControl?.loading ?? false, error: admissionControl?.error, admit, deny };
}
