import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CompletePasswordResetPage } from "../components/dashboard/PasswordResetPage";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordRoute,
});

function ResetPasswordRoute() {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const resetToken = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "";
    setToken((current) => current ?? resetToken);
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }, []);
  return <CompletePasswordResetPage token={token} />;
}
