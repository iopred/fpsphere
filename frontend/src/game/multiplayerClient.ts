import type { BackendWorldSnapshot } from "./worldApi";

export interface RemotePlayerState {
  player_id: string;
  position_3d: [number, number, number];
  yaw: number;
  pitch: number;
  avatar_id: string;
  last_processed_input_tick: number;
}

export interface MultiplayerSnapshot {
  world_id: string;
  server_tick: number;
  players: RemotePlayerState[];
}

export interface MultiplayerSnapshotDelta {
  world_id: string;
  server_tick: number;
  baseline_server_tick: number;
  upsert_players: RemotePlayerState[];
  removed_player_ids: string[];
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

interface StateSnapshotDeltaMessage extends MultiplayerSnapshotDelta {
  type: "state_snapshot_delta";
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
  | StateSnapshotDeltaMessage
  | WorldCommitAppliedMessage
  | ErrorMessage
  | PongMessage;

interface PlayerUpdateMessage {
  type: "player_update";
  position_3d: [number, number, number];
  yaw: number;
  pitch: number;
  client_tick: number;
  avatar_id?: string;
  focus_sphere_id?: string | null;
}

interface HelloMessage {
  type: "hello";
  user_id: string;
  world_id: string;
  avatar_id?: string;
  focus_sphere_id?: string | null;
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
  avatarId?: string;
  focusSphereId?: string | null;
  callbacks: MultiplayerClientCallbacks;
}

export function applyMultiplayerSnapshotDelta(
  baseline: MultiplayerSnapshot | null,
  delta: MultiplayerSnapshotDelta,
): MultiplayerSnapshot | null {
  if (!baseline) {
    return null;
  }
  if (baseline.world_id !== delta.world_id) {
    return null;
  }
  if (baseline.server_tick !== delta.baseline_server_tick) {
    return null;
  }

  const playersById = new Map<string, RemotePlayerState>();
  for (const player of baseline.players) {
    playersById.set(player.player_id, player);
  }

  for (const playerId of delta.removed_player_ids) {
    playersById.delete(playerId);
  }
  for (const player of delta.upsert_players) {
    playersById.set(player.player_id, player);
  }

  const players = [...playersById.values()].sort((left, right) =>
    left.player_id.localeCompare(right.player_id),
  );
  return {
    world_id: delta.world_id,
    server_tick: delta.server_tick,
    players,
  };
}

export class MultiplayerClient {
  private socket: WebSocket | null = null;
  private callbacks: MultiplayerClientCallbacks | null = null;
  private worldId = "";
  private userId = "";
  private lastSnapshotBaseline: MultiplayerSnapshot | null = null;

  connect(params: ConnectMultiplayerParams): void {
    this.disconnect();
    this.callbacks = params.callbacks;
    this.worldId = params.worldId;
    this.userId = params.userId;
    this.lastSnapshotBaseline = null;

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
        avatar_id: params.avatarId,
        focus_sphere_id: params.focusSphereId ?? null,
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
        this.lastSnapshotBaseline = parsed;
        this.callbacks?.onSnapshot(parsed);
        return;
      }

      if (parsed.type === "state_snapshot_delta") {
        const merged = applyMultiplayerSnapshotDelta(this.lastSnapshotBaseline, parsed);
        if (!merged) {
          this.lastSnapshotBaseline = null;
          this.callbacks?.onError("snapshot delta dropped: missing or mismatched baseline");
          return;
        }

        this.lastSnapshotBaseline = merged;
        this.callbacks?.onSnapshot(merged);
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
      this.lastSnapshotBaseline = null;
    };
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.lastSnapshotBaseline = null;
  }

  sendPlayerUpdate(
    position3d: [number, number, number],
    yaw: number,
    pitch: number,
    inputSequence: number,
    avatarId?: string,
    focusSphereId?: string | null,
  ): void {
    this.send({
      type: "player_update",
      position_3d: position3d,
      yaw,
      pitch,
      client_tick: inputSequence,
      avatar_id: avatarId,
      focus_sphere_id: focusSphereId ?? null,
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
