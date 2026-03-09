import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function WhiteboardTab({ tenant, tenantId, onSuccess }: { tenant: Record<string, unknown>; tenantId: string; onSuccess: () => void }) {
  const [json, setJson] = useState(() => JSON.stringify(tenant.whiteboard_config ?? {}, null, 2));
  const [parseError, setParseError] = useState("");

  const mutation = useMutation({
    mutationFn: (config: Record<string, unknown>) => api.updateWhiteboardConfig(tenantId, config),
    onSuccess,
  });

  const handleSave = () => {
    try {
      const parsed = JSON.parse(json);
      setParseError("");
      mutation.mutate(parsed);
    } catch {
      setParseError("Invalid JSON");
    }
  };

  return (
    <div className="max-w-lg space-y-4 pt-4">
      <div className="grid gap-2">
        <Label>Whiteboard Config (JSON)</Label>
        <Textarea className="min-h-48 font-mono text-xs" value={json} onChange={(e) => setJson(e.target.value)} />
      </div>

      {parseError && <p className="text-sm text-destructive">{parseError}</p>}
      {mutation.isSuccess && <p className="text-sm text-green-600">Config saved.</p>}
      {mutation.isError && <p className="text-sm text-destructive">{mutation.error?.message ?? "Failed to save."}</p>}

      <Button onClick={handleSave} disabled={mutation.isPending}>
        {mutation.isPending ? "Saving..." : "Save Config"}
      </Button>
    </div>
  );
}
