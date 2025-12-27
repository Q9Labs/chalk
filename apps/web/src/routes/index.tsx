import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@chalk/ui";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@chalk/ui";

export const Route = createFileRoute("/")({ component: App });

function App() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <div className="max-w-2xl space-y-8 text-center">
        <div className="space-y-4">
          <h1 className="text-5xl font-bold tracking-tight">Chalk</h1>
          <p className="text-xl text-muted-foreground">
            Ultra low-latency video conferencing built on Cloudflare RealtimeKit
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>SDK Demo</CardTitle>
              <CardDescription>
                Try out the @chalk/react SDK with live video
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link to="/demo">
                <Button className="w-full">Launch Demo</Button>
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Documentation</CardTitle>
              <CardDescription>
                Learn how to integrate Chalk into your app
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" className="w-full" disabled>
                Coming Soon
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="pt-8 text-sm text-muted-foreground">
          <code className="bg-muted rounded px-2 py-1">
            npm install @chalk/react
          </code>
        </div>
      </div>
    </div>
  );
}