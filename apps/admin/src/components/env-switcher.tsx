import { useState } from "react";
import { getEnv, setEnv, setSecret } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function EnvSwitcher() {
  const [open, setOpen] = useState(false);
  const [env, setEnvState] = useState(getEnv);
  const [secret, setSecretState] = useState("");

  function handleSwitch() {
    const newEnv = env === "local" ? "prod" : "local";
    if (newEnv === "prod") {
      setEnvState(newEnv);
      setOpen(true);
    } else {
      setEnv(newEnv);
      setEnvState(newEnv);
      window.location.reload();
    }
  }

  function handleConfirm() {
    setEnv("prod");
    setSecret(secret);
    setOpen(false);
    window.location.reload();
  }

  const isLocal = getEnv() === "local";

  return (
    <>
      <button onClick={handleSwitch} className="flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent w-full">
        <span className={`h-2 w-2 rounded-full ${isLocal ? "bg-green-500" : "bg-orange-500"}`} />
        <span>{isLocal ? "Local" : "Production"}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect to Production</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Enter the admin secret for the production API. Retrieve it with:</p>
            <pre className="text-xs bg-muted p-2 rounded-md overflow-x-auto">
              aws secretsmanager get-secret-value \{"\n"}
              {"  "}--secret-id "chalk/prod/admin-secret" \{"\n"}
              {"  "}--profile q9labs --region us-east-1 \{"\n"}
              {"  "}--query SecretString --output text
            </pre>
            <div className="space-y-1.5">
              <Label htmlFor="admin-secret">Admin Secret</Label>
              <Input id="admin-secret" type="password" value={secret} onChange={(e) => setSecretState(e.target.value)} placeholder="Paste admin secret..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={!secret}>
              Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
