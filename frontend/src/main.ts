import "./style.css";
import { GameApp } from "./game/GameApp";
import { FpsphereArApp } from "./ar/FpsphereArApp";
import { FpsphereQrPrintApp } from "./ar/FpsphereQrPrintApp";

interface StartableApp {
  start(): void;
  dispose?(): void;
}

const mountNode = document.querySelector<HTMLDivElement>("#app");
if (!mountNode) {
  throw new Error("Unable to find #app mount node");
}

const searchParams = new URLSearchParams(window.location.search);
const mode = (searchParams.get("mode") ?? "").toLowerCase();

let app: StartableApp;
if (mode === "ar") {
  app = new FpsphereArApp(mountNode);
} else if (mode === "qr") {
  app = new FpsphereQrPrintApp(mountNode);
} else {
  app = new GameApp(mountNode);
}

app.start();

window.addEventListener("beforeunload", () => {
  app.dispose?.();
});
