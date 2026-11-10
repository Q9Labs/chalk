import { createFileRoute } from "@tanstack/react-router";

import { RecordingsPage } from "../components/dashboard/RecordingsPage";
import { parseRecordingsSearch } from "../lib/dashboard/search";

export const Route = createFileRoute("/dashboard/_app/recordings")({ validateSearch: parseRecordingsSearch, component: RecordingsRoute });

function RecordingsRoute() {
  return <RecordingsPage search={Route.useSearch()} />;
}
