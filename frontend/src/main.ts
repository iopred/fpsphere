import "./style.css";
import { GameApp } from "./game/GameApp";

const mountNode = document.querySelector<HTMLDivElement>("#app");
if (!mountNode) {
  throw new Error("Unable to find #app mount node");
}

const app = new GameApp(mountNode);
app.start();
