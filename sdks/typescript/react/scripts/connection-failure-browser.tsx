import { createRoot } from "react-dom/client";
import { createSpaceClient } from "@q9labsai/chalk-client";
import { Chalk } from "../src/components/chalk/Chalk";

const client = createSpaceClient({ space: "test", baseUrl: "http://127.0.0.1:18798", getAccess: async () => fetch("/access") });
createRoot(document.getElementById("root")!).render(<Chalk client={client} defaults={{ microphone: false, camera: false }} spaceName="Test call" theme={{ colorScheme: new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark" }} />);
window.addEventListener("pagehide", () => client.dispose(), { once: true });
