import "./style.css";

interface StartableApp {
  start(): void;
  dispose?(): void;
}

const mountNode = document.querySelector<HTMLDivElement>("#app");
if (!mountNode) {
  throw new Error("Unable to find #app mount node");
}
const appMountNode: HTMLDivElement = mountNode;

const searchParams = new URLSearchParams(window.location.search);
const mode = (searchParams.get("mode") ?? "").toLowerCase();

async function createApp(modeValue: string): Promise<StartableApp> {
  if (modeValue === "ar") {
    const { FpsphereArApp } = await import("./ar/FpsphereArApp");
    return new FpsphereArApp(appMountNode);
  }

  if (modeValue === "qr") {
    const { FpsphereQrPrintApp } = await import("./ar/FpsphereQrPrintApp");
    return new FpsphereQrPrintApp(appMountNode);
  }

  if (modeValue === "avatar") {
    const { AvatarEditorApp } = await import("./game/AvatarEditorApp");
    return new AvatarEditorApp(appMountNode);
  }

  const { GameApp } = await import("./game/GameApp");
  return new GameApp(appMountNode);
}

const app = await createApp(mode);

app.start();

window.addEventListener("beforeunload", () => {
  app.dispose?.();
});
