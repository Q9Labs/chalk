export function JsonViewer({ data }: { data: unknown }) {
  return <pre className="text-xs bg-muted p-3 rounded-md overflow-x-auto max-h-96">{JSON.stringify(data, null, 2)}</pre>;
}
