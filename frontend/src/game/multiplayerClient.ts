import type { BackendWorldSnapshot } from "./worldApi";

export interface RemotePlayerState {
  player_id: string;
  position_3d: [number, number, number];
  yaw: number;
  pitch: number;
  last_processed_input_tick: number;
}

export interface MultiplayerSnapshot {
  world_id: string;
  server_tick: number;
  players: RemotePlayerState[];
}

interface WelcomeMessage {
  type: "welcome";
  player_id: string;
  user_id: string;
  world_id: string;
}

interface StateSnapshotMessage extends MultiplayerSnapshot {
  type: "state_snapshot";
}

export interface MultiplayerWorldCommit {
  world_id: string;
  commit_id: string;
  saved_to: "master" | "user";
  user_id: string | null;
  world: BackendWorldSnapshot;
}

interface WorldCommitAppliedMessage extends MultiplayerWorldCommit {
  type: "world_commit_applied";
}

interface ErrorMessage {
  type: "error";
  message: string;
}

interface PongMessage {
  type: "pong";
}

type ServerMessage =
  | WelcomeMessage
  | StateSnapshotMessage
  | WorldCommitAppliedMessage
  | ErrorMessage
  | PongMessage;

interface PlayerUpdateMessage {
  type: "player_update";
  position_3d: [number, number, number];
  yaw: number;
  pitch: number;
  client_tick: number;
}

interface HelloMessage {
  type: "hello";
  user_id: string;
  world_id: string;
}

interface PingMessage {
  type: "ping";
}

type ClientMessage = HelloMessage | PlayerUpdateMessage | PingMessage;

export interface MultiplayerClientCallbacks {
  onStatus: (status: string) => void;
  onWelcome: (playerId: string) => void;
  onSnapshot: (snapshot: MultiplayerSnapshot) => void;
  onWorldCommit: (commit: MultiplayerWorldCommit) => void;
  onError: (message: string) => void;
}

export interface ConnectMultiplayerParams {
  userId: string;
  worldId: string;
  callbacks: MultiplayerClientCallbacks;
}

export class MultiplayerClient {
  private socket: WebSocket | null = null;
  private callbacks: MultiplayerClientCallbacks | null = null;
  private worldId = "";
  private userId = "";

  connect(params: ConnectMultiplayerParams): void {
    this.disconnect();
    this.callbacks = params.callbacks;
    this.worldId = params.worldId;
    this.userId = params.userId;

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${window.location.host}/ws?user_id=${encodeURIComponent(params.userId)}&world_id=${encodeURIComponent(params.worldId)}`;

    const socket = new WebSocket(url);
    this.socket = socket;
    this.callbacks.onStatus("connecting");

    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }

      this.callbacks?.onStatus("connected");
      this.send({
        type: "hello",
        user_id: this.userId,
        world_id: this.worldId,
      });
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== socket) {
        return;
      }

      if (typeof event.data !== "string") {
        return;
      }

      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(event.data) as ServerMessage;
      } catch {
        this.callbacks?.onError("invalid multiplayer message");
        return;
      }

      if (parsed.type === "welcome") {
        this.callbacks?.onWelcome(parsed.player_id);
        return;
      }

      if (parsed.type === "state_snapshot") {
        this.callbacks?.onSnapshot(parsed);
        return;
      }

      if (parsed.type === "world_commit_applied") {
        this.callbacks?.onWorldCommit(parsed);
        return;
      }

      if (parsed.type === "error") {
        this.callbacks?.onError(parsed.message);
      }
    };

    socket.onerror = () => {
      if (this.socket !== socket) {
        return;
      }

      this.callbacks?.onStatus("error");
    };

    socket.onclose = () => {
      if (this.socket !== socket) {
        return;
      }

      this.callbacks?.onStatus("disconnected");
      this.socket = null;
    };
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  sendPlayerUpdate(
    position3d: [number, number, number],
    yaw: number,
    pitch: number,
    inputSequence: number,
  ): void {
    this.send({
      type: "player_update",
      position_3d: position3d,
      yaw,
      pitch,
      client_tick: inputSequence,
    });
  }

  ping(): void {
    this.send({ type: "ping" });
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }
}
