import { buildSeedWorld, type SeedWorld } from "./worldSeed";
import {
  commitWorldChanges,
  createWorldLevel,
  deleteWorldLevel,
  fetchAvailableWorldIds,
  fetchWorldSeed,
  type WorldCommitOperation,
  WorldCommitError,
} from "./worldApi";

export type WorldSourceState = "seed" | "loading" | "backend" | "backend-user";

export interface LevelLifecycleUiRefs {
  levelSelectNode: HTMLDivElement;
  levelSelectStatusNode: HTMLDivElement;
  levelSelectDropdown: HTMLSelectElement;
  levelRemoveButton: HTMLButtonElement;
  levelCreateInput: HTMLInputElement;
  levelCreateButton: HTMLButtonElement;
  levelSelectRefreshButton: HTMLButtonElement;
}

export interface LevelLifecycleCallbacks {
  userId: string;
  isDisposed: () => boolean;
  isEditorMode: () => boolean;
  getPendingCommitOperations: () => WorldCommitOperation[];
  replacePendingCommitOperations: (operations: WorldCommitOperation[]) => void;
  stopDraggingSphere: () => void;
  deselectSphere: () => void;
  updateWorldQueryParam: (worldId: string) => void;
  connectMultiplayer: (worldId: string) => void;
  movePlayerToCurrentWorld: () => void;
  hydrateWorld: (world: SeedWorld) => boolean;
  getTemplateFocusSphereId: () => string | null;
}

export interface LevelLifecycleOptions {
  defaultWorldId: string;
  initialWorldId?: string;
  ui: LevelLifecycleUiRefs;
  callbacks: LevelLifecycleCallbacks;
}

export class LevelLifecycleController {
  private readonly defaultWorldId: string;
  private readonly ui: LevelLifecycleUiRefs;
  private readonly callbacks: LevelLifecycleCallbacks;

  private currentWorldId: string;
  private availableWorldIds: string[];
  private loadingWorldId: string | null = null;
  private levelMutationInFlight = false;
  private levelSelectMessage: string | null = null;
  private worldLoadVersion = 0;
  private saveInFlight = false;
  private saveMessage = "no pending edits";
  private backendWorldTick = 0;
  private worldSourceState: WorldSourceState = "loading";

  constructor(options: LevelLifecycleOptions) {
    this.defaultWorldId = options.defaultWorldId;
    this.ui = options.ui;
    this.callbacks = options.callbacks;

    const normalizedInitialWorldId =
      options.initialWorldId?.trim() && options.initialWorldId.trim().length > 0
        ? options.initialWorldId.trim()
        : this.defaultWorldId;
    this.currentWorldId = normalizedInitialWorldId;
    this.availableWorldIds = [normalizedInitialWorldId];
  }

  get worldId(): string {
    return this.currentWorldId;
  }

  get worldIds(): string[] {
    return this.availableWorldIds;
  }

  get currentSaveMessage(): string {
    return this.saveMessage;
  }

  get currentBackendWorldTick(): number {
    return this.backendWorldTick;
  }

  get currentWorldSourceState(): WorldSourceState {
    return this.worldSourceState;
  }

  get isSaveInFlight(): boolean {
    return this.saveInFlight;
  }

  async initializeLevelSelection(): Promise<void> {
    await this.refreshAvailableWorldIds({ preserveCurrentWorldId: true });
    await this.selectWorldLevel(this.currentWorldId, true);
  }

  async refreshAvailableWorldIds(options: {
    preserveCurrentWorldId: boolean;
  }): Promise<void> {
    const { preserveCurrentWorldId } = options;
    const fallbackWorldIds = [...this.availableWorldIds];
    this.ui.levelSelectRefreshButton.disabled = true;

    try {
      const fetchedWorldIds = await fetchAvailableWorldIds();
      if (this.callbacks.isDisposed()) {
        return;
      }

      const normalizedWorldIds = this.normalizeWorldIds(fetchedWorldIds);
      this.availableWorldIds =
        normalizedWorldIds.length > 0 ? normalizedWorldIds : this.normalizeWorldIds(fallbackWorldIds);
    } catch (error) {
      console.warn("Failed to fetch world list", error);
      this.availableWorldIds = this.normalizeWorldIds(fallbackWorldIds);
      this.levelSelectMessage =
        error instanceof Error ? `level refresh failed: ${error.message}` : "level refresh failed";
    } finally {
      if (!this.callbacks.isDisposed()) {
        this.availableWorldIds = preserveCurrentWorldId
          ? this.normalizeWorldIds([this.currentWorldId, ...this.availableWorldIds])
          : this.normalizeWorldIds(this.availableWorldIds);
        this.renderLevelSelectHud();
      }
    }
  }

  async createLevelFromInput(): Promise<void> {
    if (this.isLevelSelectBusy()) {
      return;
    }

    const requestedWorldId = this.ui.levelCreateInput.value.trim();
    if (requestedWorldId.length === 0) {
      this.levelSelectMessage = "enter a level id";
      this.renderLevelSelectHud();
      return;
    }

    this.levelMutationInFlight = true;
    this.levelSelectMessage = `creating "${requestedWorldId}"...`;
    this.renderLevelSelectHud();

    try {
      const createdWorldId = await createWorldLevel(requestedWorldId);
      if (this.callbacks.isDisposed()) {
        return;
      }

      this.ui.levelCreateInput.value = "";
      this.levelSelectMessage = `created "${createdWorldId}"`;
      await this.refreshAvailableWorldIds({ preserveCurrentWorldId: true });
      await this.selectWorldLevel(createdWorldId, true);
    } catch (error) {
      if (this.callbacks.isDisposed()) {
        return;
      }

      this.levelSelectMessage =
        error instanceof Error ? `create failed: ${error.message}` : "create failed";
    } finally {
      if (!this.callbacks.isDisposed()) {
        this.levelMutationInFlight = false;
        this.renderLevelSelectHud();
      }
    }
  }

  async deleteWorldLevelById(worldId: string): Promise<void> {
    if (this.isLevelSelectBusy()) {
      return;
    }

    if (this.availableWorldIds.length <= 1) {
      this.levelSelectMessage = "cannot remove the last level";
      this.renderLevelSelectHud();
      return;
    }

    if (!window.confirm(`Delete level "${worldId}"?`)) {
      return;
    }

    const deletingCurrentWorld = worldId === this.currentWorldId;
    this.levelMutationInFlight = true;
    this.levelSelectMessage = `removing "${worldId}"...`;
    this.renderLevelSelectHud();

    try {
      await deleteWorldLevel(worldId);
      if (this.callbacks.isDisposed()) {
        return;
      }

      this.levelSelectMessage = `removed "${worldId}"`;
      await this.refreshAvailableWorldIds({
        preserveCurrentWorldId: !deletingCurrentWorld,
      });

      if (deletingCurrentWorld) {
        const nextWorldId = this.availableWorldIds[0] ?? this.defaultWorldId;
        await this.selectWorldLevel(nextWorldId, true);
      }
    } catch (error) {
      if (this.callbacks.isDisposed()) {
        return;
      }

      this.levelSelectMessage =
        error instanceof Error ? `remove failed: ${error.message}` : "remove failed";
    } finally {
      if (!this.callbacks.isDisposed()) {
        this.levelMutationInFlight = false;
        this.renderLevelSelectHud();
      }
    }
  }

  async selectWorldLevel(worldIdInput: string, force: boolean = false): Promise<void> {
    const worldId = worldIdInput.trim();
    if (worldId.length === 0) {
      return;
    }

    if (!force && worldId === this.currentWorldId && this.loadingWorldId === null) {
      return;
    }

    const requestVersion = this.worldLoadVersion + 1;
    this.worldLoadVersion = requestVersion;
    this.loadingWorldId = worldId;
    this.currentWorldId = worldId;
    this.levelSelectMessage = null;
    this.availableWorldIds = this.normalizeWorldIds([worldId, ...this.availableWorldIds]);
    this.callbacks.replacePendingCommitOperations([]);
    this.refreshPendingSaveMessage();
    this.saveMessage = `loading level "${worldId}"...`;
    this.callbacks.stopDraggingSphere();
    this.callbacks.deselectSphere();
    this.callbacks.updateWorldQueryParam(worldId);
    this.renderLevelSelectHud();
    this.callbacks.connectMultiplayer(worldId);

    await this.loadWorldFromBackend(worldId, requestVersion);
    if (this.callbacks.isDisposed() || requestVersion !== this.worldLoadVersion) {
      return;
    }

    this.loadingWorldId = null;
    this.callbacks.movePlayerToCurrentWorld();
    this.renderLevelSelectHud();
  }

  refreshPendingSaveMessage(): void {
    if (this.saveInFlight) {
      return;
    }

    const pendingOperationCount = this.callbacks.getPendingCommitOperations().length;
    if (pendingOperationCount === 0) {
      this.saveMessage = "no pending edits";
      return;
    }

    this.saveMessage = `pending edits: ${pendingOperationCount}`;
  }

  async saveWorldCommit(): Promise<void> {
    if (this.saveInFlight) {
      return;
    }

    const operations = this.callbacks.getPendingCommitOperations();
    if (operations.length === 0) {
      this.saveMessage = "no pending edits";
      return;
    }

    this.saveInFlight = true;
    this.saveMessage = `saving ${operations.length} edit(s)...`;
    this.renderLevelSelectHud();

    try {
      const response = await commitWorldChanges({
        worldId: this.currentWorldId,
        userId: this.callbacks.userId,
        baseTick: this.backendWorldTick,
        operations,
        focusSphereId: this.callbacks.getTemplateFocusSphereId(),
      });

      this.callbacks.hydrateWorld(response.world);
      this.backendWorldTick = response.tick;
      this.callbacks.replacePendingCommitOperations([]);
      this.worldSourceState = response.savedTo === "master" ? "backend" : "backend-user";
      const reasonSuffix = response.reason ? ` (${response.reason})` : "";
      this.saveMessage = `saved ${response.commitId} -> ${response.savedTo}${reasonSuffix}`;
    } catch (error) {
      if (error instanceof WorldCommitError) {
        if (error.validationErrors.length > 0) {
          this.saveMessage = `save failed: ${error.validationErrors[0]}`;
        } else {
          this.saveMessage = `save failed: ${error.message}`;
        }
      } else if (error instanceof Error) {
        this.saveMessage = `save failed: ${error.message}`;
      } else {
        this.saveMessage = "save failed: unknown error";
      }
    } finally {
      this.saveInFlight = false;
      this.renderLevelSelectHud();
    }
  }

  applyMultiplayerWorldCommit(commitId: string, savedTo: "master" | "user", tick: number): void {
    this.backendWorldTick = tick;
    this.worldSourceState = savedTo === "master" ? "backend" : "backend-user";
    if (!this.saveInFlight) {
      this.saveMessage = `synced ${commitId} via multiplayer`;
    }
  }

  renderLevelSelectHud(): void {
    this.ui.levelSelectNode.hidden = !this.callbacks.isEditorMode();
    if (!this.callbacks.isEditorMode()) {
      return;
    }

    if (this.loadingWorldId) {
      this.ui.levelSelectStatusNode.textContent = `Loading "${this.loadingWorldId}"...`;
    } else if (this.levelMutationInFlight) {
      this.ui.levelSelectStatusNode.textContent = "Updating levels...";
    } else if (this.levelSelectMessage) {
      this.ui.levelSelectStatusNode.textContent = this.levelSelectMessage;
    } else {
      this.ui.levelSelectStatusNode.textContent = `Current: ${this.currentWorldId}`;
    }

    const controlsDisabled = this.isLevelSelectBusy();
    this.ui.levelCreateInput.disabled = controlsDisabled;
    this.ui.levelCreateButton.disabled = controlsDisabled;
    const selectedWorldId = this.availableWorldIds.includes(this.currentWorldId)
      ? this.currentWorldId
      : (this.availableWorldIds[0] ?? "");
    this.ui.levelSelectDropdown.textContent = "";
    for (const worldId of this.availableWorldIds) {
      const option = document.createElement("option");
      option.value = worldId;
      option.textContent = worldId;
      this.ui.levelSelectDropdown.appendChild(option);
    }
    this.ui.levelSelectDropdown.value = selectedWorldId;
    this.ui.levelSelectDropdown.disabled = controlsDisabled || this.availableWorldIds.length === 0;
    this.ui.levelRemoveButton.disabled = controlsDisabled || this.availableWorldIds.length <= 1;

    this.ui.levelSelectRefreshButton.disabled = controlsDisabled;
  }

  private normalizeWorldIds(worldIds: string[]): string[] {
    const normalizedWorldIds: string[] = [];
    const seenWorldIds = new Set<string>();

    for (const worldId of worldIds) {
      if (!worldId || worldId.trim().length === 0) {
        continue;
      }
      if (seenWorldIds.has(worldId)) {
        continue;
      }

      seenWorldIds.add(worldId);
      normalizedWorldIds.push(worldId);
    }

    return normalizedWorldIds;
  }

  private isLevelSelectBusy(): boolean {
    return this.loadingWorldId !== null || this.saveInFlight || this.levelMutationInFlight;
  }

  private async loadWorldFromBackend(worldId: string, requestVersion: number): Promise<void> {
    this.worldSourceState = "loading";
    this.renderLevelSelectHud();

    try {
      const loadedWorld = await fetchWorldSeed(worldId, this.callbacks.userId);
      if (this.callbacks.isDisposed() || requestVersion !== this.worldLoadVersion) {
        return;
      }

      const hydrated = this.callbacks.hydrateWorld(loadedWorld.world);
      this.backendWorldTick = loadedWorld.tick;
      this.callbacks.replacePendingCommitOperations([]);
      this.refreshPendingSaveMessage();
      this.worldSourceState = hydrated ? "backend" : "seed";
      this.levelSelectMessage = null;
      this.saveMessage = `loaded level "${worldId}"`;
    } catch (error) {
      if (this.callbacks.isDisposed() || requestVersion !== this.worldLoadVersion) {
        return;
      }

      this.callbacks.hydrateWorld(buildSeedWorld());
      this.backendWorldTick = 0;
      this.callbacks.replacePendingCommitOperations([]);
      this.refreshPendingSaveMessage();
      this.worldSourceState = "seed";
      this.levelSelectMessage = `load failed for "${worldId}"`;
      this.saveMessage = `load failed for "${worldId}", using seed fallback`;
      console.warn("Failed to load world from backend, using local seed world", error);
    }
  }
}
