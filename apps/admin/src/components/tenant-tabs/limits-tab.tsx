import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LimitsTab({ tenant, tenantId, onSuccess }: { tenant: Record<string, unknown>; tenantId: string; onSuccess: () => void }) {
  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.updateTenant(tenantId, data),
    onSuccess,
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    const toNum = (key: string) => {
      const v = String(fd.get(key)).trim();
      return v ? Number(v) : undefined;
    };

    mutation.mutate({
      name: String(fd.get("name")).trim(),
      max_concurrent_rooms: toNum("max_concurrent_rooms"),
      max_participants_per_room: toNum("max_participants_per_room"),
      max_recording_duration_minutes: toNum("max_recording_duration_minutes"),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md space-y-4 pt-4">
      <div className="grid gap-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" defaultValue={String(tenant.name ?? "")} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="max_concurrent_rooms">Max Concurrent Rooms</Label>
        <Input id="max_concurrent_rooms" name="max_concurrent_rooms" type="number" defaultValue={String(tenant.max_concurrent_rooms ?? "")} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="max_participants_per_room">Max Participants per Room</Label>
        <Input id="max_participants_per_room" name="max_participants_per_room" type="number" defaultValue={String(tenant.max_participants_per_room ?? "")} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="max_recording_duration_minutes">Max Recording Duration (min)</Label>
        <Input id="max_recording_duration_minutes" name="max_recording_duration_minutes" type="number" defaultValue={String(tenant.max_recording_duration_minutes ?? "")} />
      </div>

      {mutation.isSuccess && <p className="text-sm text-green-600">Saved successfully.</p>}
      {mutation.isError && <p className="text-sm text-destructive">{mutation.error?.message ?? "Failed to save."}</p>}

      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? "Saving..." : "Save"}
      </Button>
    </form>
  );
}
