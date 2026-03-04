const LOOK_SENSITIVITY = 0.0023;
const MAX_PITCH = Math.PI * 0.49;

export interface MovementInput {
  forward: number;
  right: number;
  jump: boolean;
}

export interface Orientation {
  yaw: number;
  pitch: number;
}

export class FpsController {
  private readonly keys = new Set<string>();
  private yaw = 0;
  private pitch = 0;
  private jumpQueued = false;
  private connected = false;
  private lookSuppressed = false;

  constructor(private readonly lockElement: HTMLElement) {}

  connect(): void {
    if (this.connected) {
      return;
    }

    this.lockElement.addEventListener("click", this.requestPointerLock);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    this.connected = true;
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }

    this.lockElement.removeEventListener("click", this.requestPointerLock);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    this.keys.clear();
    this.connected = false;
  }

  isPointerLocked(): boolean {
    return document.pointerLockElement === this.lockElement;
  }

  getOrientation(): Orientation {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  setLookSuppressed(suppressed: boolean): void {
    this.lookSuppressed = suppressed;
  }

  sampleInput(): MovementInput {
    if (!this.isPointerLocked()) {
      this.keys.clear();
      this.jumpQueued = false;
      return { forward: 0, right: 0, jump: false };
    }

    const forward = (this.keys.has("KeyW") ? 1 : 0) - (this.keys.has("KeyS") ? 1 : 0);
    const right = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const jump = this.jumpQueued;
    this.jumpQueued = false;

    return { forward, right, jump };
  }

  private readonly requestPointerLock = (): void => {
    void this.lockElement.requestPointerLock();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.isPointerLocked()) {
      return;
    }
    if (this.lookSuppressed) {
      return;
    }

    this.yaw -= event.movementX * LOOK_SENSITIVITY;
    this.pitch -= event.movementY * LOOK_SENSITIVITY;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
    if (event.code === "Space") {
      this.jumpQueued = true;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };
}
