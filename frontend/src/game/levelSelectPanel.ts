import type { LevelLifecycleUiRefs } from "./levelLifecycleController";

export interface LevelSelectPanelCallbacks {
  onSelectWorld: (worldId: string) => void;
  onRemoveSelectedWorld: (worldId: string) => void;
  onCreateFromInput: () => void;
  onRefresh: () => void;
}

export class LevelSelectPanel {
  readonly rootNode: HTMLDivElement;
  readonly refs: LevelLifecycleUiRefs;

  constructor(callbacks: LevelSelectPanelCallbacks) {
    this.rootNode = document.createElement("div");
    this.rootNode.className = "level-select";

    const titleNode = document.createElement("div");
    titleNode.className = "level-select-title";
    titleNode.textContent = "Level Select";
    this.rootNode.appendChild(titleNode);

    const statusNode = document.createElement("div");
    statusNode.className = "level-select-status";
    this.rootNode.appendChild(statusNode);

    const selectRowNode = document.createElement("div");
    selectRowNode.className = "level-select-row";

    const dropdownNode = document.createElement("select");
    dropdownNode.className = "level-select-dropdown";
    dropdownNode.addEventListener("change", () => {
      callbacks.onSelectWorld(dropdownNode.value);
    });
    selectRowNode.appendChild(dropdownNode);

    const removeButtonNode = document.createElement("button");
    removeButtonNode.type = "button";
    removeButtonNode.className = "level-select-delete";
    removeButtonNode.textContent = "Remove";
    removeButtonNode.addEventListener("click", () => {
      callbacks.onRemoveSelectedWorld(dropdownNode.value);
    });
    selectRowNode.appendChild(removeButtonNode);
    this.rootNode.appendChild(selectRowNode);

    const createRowNode = document.createElement("div");
    createRowNode.className = "level-select-create";

    const createInputNode = document.createElement("input");
    createInputNode.className = "level-select-input";
    createInputNode.type = "text";
    createInputNode.placeholder = "new-level-id";
    createInputNode.autocomplete = "off";
    createInputNode.spellcheck = false;
    createInputNode.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      callbacks.onCreateFromInput();
    });
    createRowNode.appendChild(createInputNode);

    const createButtonNode = document.createElement("button");
    createButtonNode.type = "button";
    createButtonNode.className = "level-select-create-button";
    createButtonNode.textContent = "Add";
    createButtonNode.addEventListener("click", () => {
      callbacks.onCreateFromInput();
    });
    createRowNode.appendChild(createButtonNode);
    this.rootNode.appendChild(createRowNode);

    const refreshButtonNode = document.createElement("button");
    refreshButtonNode.type = "button";
    refreshButtonNode.className = "level-select-refresh";
    refreshButtonNode.textContent = "Refresh";
    refreshButtonNode.addEventListener("click", () => {
      callbacks.onRefresh();
    });
    this.rootNode.appendChild(refreshButtonNode);

    this.refs = {
      levelSelectNode: this.rootNode,
      levelSelectStatusNode: statusNode,
      levelSelectDropdown: dropdownNode,
      levelRemoveButton: removeButtonNode,
      levelCreateInput: createInputNode,
      levelCreateButton: createButtonNode,
      levelSelectRefreshButton: refreshButtonNode,
    };
  }
}
