const NONE_WORLD_OPTION_VALUE = "__none__";

export interface TemplateHudPanelCallbacks {
  onSelectCreateWorld: (instanceWorldId: string | null) => void;
  onSelectSelectedWorld: (instanceWorldId: string | null) => void;
  onAdjustAvatar: (delta: number) => void;
  onColorInput: (value: string) => void;
}

export interface TemplateHudPanelRenderState {
  editorMode: boolean;
  createInstanceWorldId: string | null;
  selectedInstanceWorldId: string | null | undefined;
  availableInstanceWorldIds: string[];
  avatarLabel: string;
  selectedColorValue: string;
}

export class TemplateHudPanel {
  readonly rootNode: HTMLDivElement;
  private readonly createWorldSelectNode: HTMLSelectElement;
  private readonly selectedWorldSelectNode: HTMLSelectElement;
  private readonly avatarDecreaseButton: HTMLButtonElement;
  private readonly avatarIncreaseButton: HTMLButtonElement;
  private readonly avatarValueNode: HTMLSpanElement;
  private readonly selectedColorRowNode: HTMLDivElement;
  private readonly selectedColorInputNode: HTMLInputElement;

  constructor(defaultColorValue: string, callbacks: TemplateHudPanelCallbacks) {
    this.rootNode = document.createElement("div");
    this.rootNode.className = "template-hud";

    const templateTitle = document.createElement("div");
    templateTitle.className = "template-hud-title";
    templateTitle.textContent = "World Instance (direct world id)";
    this.rootNode.appendChild(templateTitle);

    const createRow = document.createElement("div");
    createRow.className = "template-hud-select-row";
    const createLabel = document.createElement("span");
    createLabel.className = "template-hud-label";
    createLabel.textContent = "Create";
    createRow.appendChild(createLabel);

    this.createWorldSelectNode = document.createElement("select");
    this.createWorldSelectNode.className = "template-hud-select";
    this.createWorldSelectNode.addEventListener("change", () => {
      const value = this.createWorldSelectNode.value;
      callbacks.onSelectCreateWorld(value === NONE_WORLD_OPTION_VALUE ? null : value);
    });
    createRow.appendChild(this.createWorldSelectNode);
    this.rootNode.appendChild(createRow);

    const selectedRow = document.createElement("div");
    selectedRow.className = "template-hud-select-row";
    const selectedLabel = document.createElement("span");
    selectedLabel.className = "template-hud-label";
    selectedLabel.textContent = "Selected";
    selectedRow.appendChild(selectedLabel);

    this.selectedWorldSelectNode = document.createElement("select");
    this.selectedWorldSelectNode.className = "template-hud-select";
    this.selectedWorldSelectNode.addEventListener("change", () => {
      const value = this.selectedWorldSelectNode.value;
      callbacks.onSelectSelectedWorld(value === NONE_WORLD_OPTION_VALUE ? null : value);
    });
    selectedRow.appendChild(this.selectedWorldSelectNode);
    this.rootNode.appendChild(selectedRow);

    const avatarRow = document.createElement("div");
    avatarRow.className = "template-hud-row";
    const avatarLabelNode = document.createElement("span");
    avatarLabelNode.className = "template-hud-label";
    avatarLabelNode.textContent = "Avatar";
    avatarRow.appendChild(avatarLabelNode);

    this.avatarDecreaseButton = document.createElement("button");
    this.avatarDecreaseButton.type = "button";
    this.avatarDecreaseButton.textContent = "-";
    this.avatarDecreaseButton.addEventListener("click", () => {
      callbacks.onAdjustAvatar(-1);
    });
    avatarRow.appendChild(this.avatarDecreaseButton);

    this.avatarValueNode = document.createElement("span");
    this.avatarValueNode.className = "template-hud-value";
    avatarRow.appendChild(this.avatarValueNode);

    this.avatarIncreaseButton = document.createElement("button");
    this.avatarIncreaseButton.type = "button";
    this.avatarIncreaseButton.textContent = "+";
    this.avatarIncreaseButton.addEventListener("click", () => {
      callbacks.onAdjustAvatar(1);
    });
    avatarRow.appendChild(this.avatarIncreaseButton);
    this.rootNode.appendChild(avatarRow);

    this.selectedColorRowNode = document.createElement("div");
    this.selectedColorRowNode.className = "template-hud-color-row";

    const selectedColorLabel = document.createElement("span");
    selectedColorLabel.className = "template-hud-label";
    selectedColorLabel.textContent = "Color";
    this.selectedColorRowNode.appendChild(selectedColorLabel);

    this.selectedColorInputNode = document.createElement("input");
    this.selectedColorInputNode.type = "color";
    this.selectedColorInputNode.className = "template-hud-color-input";
    this.selectedColorInputNode.value = defaultColorValue;
    this.selectedColorInputNode.addEventListener("input", () => {
      callbacks.onColorInput(this.selectedColorInputNode.value);
    });
    this.selectedColorRowNode.appendChild(this.selectedColorInputNode);
    this.rootNode.appendChild(this.selectedColorRowNode);
  }

  contains(target: EventTarget | null): boolean {
    return target instanceof Node && this.rootNode.contains(target);
  }

  render(state: TemplateHudPanelRenderState): void {
    this.rootNode.hidden = !state.editorMode;
    this.rootNode.classList.toggle("template-hud-disabled", !state.editorMode);
    this.avatarValueNode.textContent = state.avatarLabel;

    const createEnabled = state.editorMode;
    const selectedEnabled = state.editorMode && state.selectedInstanceWorldId !== undefined;

    this.renderWorldSelect(
      this.createWorldSelectNode,
      state.availableInstanceWorldIds,
      state.createInstanceWorldId,
      "None",
    );
    this.renderWorldSelect(
      this.selectedWorldSelectNode,
      state.availableInstanceWorldIds,
      state.selectedInstanceWorldId ?? null,
      "None",
    );

    this.createWorldSelectNode.disabled = !createEnabled;
    this.selectedWorldSelectNode.disabled = !selectedEnabled;
    this.avatarDecreaseButton.disabled = !createEnabled;
    this.avatarIncreaseButton.disabled = !createEnabled;
    this.selectedColorRowNode.hidden = !selectedEnabled;
    this.selectedColorInputNode.disabled = !selectedEnabled;
    this.selectedColorInputNode.value = state.selectedColorValue;
  }

  private renderWorldSelect(
    selectNode: HTMLSelectElement,
    worldIds: string[],
    selectedInstanceWorldId: string | null,
    noneLabel: string,
  ): void {
    const options = new Set<string>();
    for (const worldId of worldIds) {
      if (worldId.trim().length > 0) {
        options.add(worldId.trim());
      }
    }
    if (selectedInstanceWorldId && selectedInstanceWorldId.trim().length > 0) {
      options.add(selectedInstanceWorldId.trim());
    }

    selectNode.textContent = "";

    const noneOption = document.createElement("option");
    noneOption.value = NONE_WORLD_OPTION_VALUE;
    noneOption.textContent = noneLabel;
    selectNode.appendChild(noneOption);

    for (const worldId of options) {
      const option = document.createElement("option");
      option.value = worldId;
      option.textContent = worldId;
      selectNode.appendChild(option);
    }

    const normalizedSelection = selectedInstanceWorldId?.trim();
    selectNode.value =
      normalizedSelection && normalizedSelection.length > 0
        ? normalizedSelection
        : NONE_WORLD_OPTION_VALUE;
  }
}
