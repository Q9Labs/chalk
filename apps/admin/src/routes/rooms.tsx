import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { format } from "date-fns";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";

export const Route = createFileRoute("/rooms")({
	component: RoomsPage,
});

function RoomsPage() {
	const navigate = useNavigate();
	const { data, isLoading } = useQuery({
		queryKey: ["admin", "rooms"],
		queryFn: () => api.listRooms(),
	});

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold">Rooms</h1>
			<DataTable
				data={data ?? []}
				isLoading={isLoading}
				onRowClick={(row) =>
					navigate({ to: "/rooms/$id", params: { id: row.id as string } })
				}
				columns={[
					{
						key: "name",
						header: "Name",
						render: (r) => (r.name as string) || "Unnamed",
					},
					{ key: "tenant_name", header: "Tenant" },
					{
						key: "status",
						header: "Status",
						render: (r) => (
							<Badge variant={r.status === "active" ? "default" : "secondary"}>
								{r.status as string}
							</Badge>
						),
					},
					{
						key: "active_participant_count",
						header: "Participants",
						render: (r) => String(r.active_participant_count ?? 0),
					},
					{
						key: "started_at",
						header: "Started",
						render: (r) => {
							const v = r.started_at as
								| { Valid?: boolean; Time?: string }
								| undefined;
							if (!v?.Valid || !v.Time) return "—";
							return format(new Date(v.Time), "PPp");
						},
					},
					{
						key: "created_at",
						header: "Created",
						render: (r) => format(new Date(r.created_at as string), "PPp"),
					},
				]}
			/>
		</div>
	);
}
