export interface TemplateHudPanelCallbacks {
  onAdjustCreateTemplate: (delta: number) => void;
  onAdjustSelectedTemplate: (delta: number) => void;
  onAdjustAvatar: (delta: number) => void;
  onColorInput: (value: string) => void;
}

export interface TemplateHudPanelRenderState {
  editorMode: boolean;
  createTemplateId: number;
  selectedTemplateId: number | null;
  avatarLabel: string;
  selectedColorValue: string;
}

export class TemplateHudPanel {
  readonly rootNode: HTMLDivElement;
  private readonly createTemplateValueNode: HTMLSpanElement;
  private readonly selectedTemplateValueNode: HTMLSpanElement;
  private readonly createTemplateDecreaseButton: HTMLButtonElement;
  private readonly createTemplateIncreaseButton: HTMLButtonElement;
  private readonly selectedTemplateDecreaseButton: HTMLButtonElement;
  private readonly selectedTemplateIncreaseButton: HTMLButtonElement;
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
    templateTitle.textContent = "Template IDs (0 = none)";
    this.rootNode.appendChild(templateTitle);

    const createRow = document.createElement("div");
    createRow.className = "template-hud-row";
    const createLabel = document.createElement("span");
    createLabel.className = "template-hud-label";
    createLabel.textContent = "Create";
    createRow.appendChild(createLabel);

    this.createTemplateDecreaseButton = document.createElement("button");
    this.createTemplateDecreaseButton.type = "button";
    this.createTemplateDecreaseButton.textContent = "-";
    this.createTemplateDecreaseButton.addEventListener("click", () => {
      callbacks.onAdjustCreateTemplate(-1);
    });
    createRow.appendChild(this.createTemplateDecreaseButton);

    this.createTemplateValueNode = document.createElement("span");
    this.createTemplateValueNode.className = "template-hud-value";
    createRow.appendChild(this.createTemplateValueNode);

    this.createTemplateIncreaseButton = document.createElement("button");
    this.createTemplateIncreaseButton.type = "button";
    this.createTemplateIncreaseButton.textContent = "+";
    this.createTemplateIncreaseButton.addEventListener("click", () => {
      callbacks.onAdjustCreateTemplate(1);
    });
    createRow.appendChild(this.createTemplateIncreaseButton);
    this.rootNode.appendChild(createRow);

    const selectedRow = document.createElement("div");
    selectedRow.className = "template-hud-row";
    const selectedLabel = document.createElement("span");
    selectedLabel.className = "template-hud-label";
    selectedLabel.textContent = "Selected";
    selectedRow.appendChild(selectedLabel);

    this.selectedTemplateDecreaseButton = document.createElement("button");
    this.selectedTemplateDecreaseButton.type = "button";
    this.selectedTemplateDecreaseButton.textContent = "-";
    this.selectedTemplateDecreaseButton.addEventListener("click", () => {
      callbacks.onAdjustSelectedTemplate(-1);
    });
    selectedRow.appendChild(this.selectedTemplateDecreaseButton);

    this.selectedTemplateValueNode = document.createElement("span");
    this.selectedTemplateValueNode.className = "template-hud-value";
    selectedRow.appendChild(this.selectedTemplateValueNode);

    this.selectedTemplateIncreaseButton = document.createElement("button");
    this.selectedTemplateIncreaseButton.type = "button";
    this.selectedTemplateIncreaseButton.textContent = "+";
    this.selectedTemplateIncreaseButton.addEventListener("click", () => {
      callbacks.onAdjustSelectedTemplate(1);
    });
    selectedRow.appendChild(this.selectedTemplateIncreaseButton);
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
    this.createTemplateValueNode.textContent = `${state.createTemplateId}`;
    this.selectedTemplateValueNode.textContent =
      state.selectedTemplateId === null ? "none" : `${state.selectedTemplateId}`;
    this.avatarValueNode.textContent = state.avatarLabel;

    const createEnabled = state.editorMode;
    const selectedEnabled = state.editorMode && state.selectedTemplateId !== null;

    this.createTemplateDecreaseButton.disabled = !createEnabled;
    this.createTemplateIncreaseButton.disabled = !createEnabled;
    this.selectedTemplateDecreaseButton.disabled = !selectedEnabled;
    this.selectedTemplateIncreaseButton.disabled = !selectedEnabled;
    this.avatarDecreaseButton.disabled = !createEnabled;
    this.avatarIncreaseButton.disabled = !createEnabled;
    this.selectedColorRowNode.hidden = !selectedEnabled;
    this.selectedColorInputNode.disabled = !selectedEnabled;
    this.selectedColorInputNode.value = state.selectedColorValue;
  }
}
