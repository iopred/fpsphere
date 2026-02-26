import {
  DEFAULT_MARKER_SIZE_METERS,
  DEFAULT_WORLD_SCALE_MULTIPLIER,
  DEFAULT_WORLD_ID,
  buildMarkerPayload,
  clampMarkerSizeMeters,
  clampWorldScaleMultiplier,
} from "./markerPayload";

const QUICKCHART_BASE_URL = "https://quickchart.io/qr";

function buildQrImageUrl(payload: string): string {
  const encodedPayload = encodeURIComponent(payload);
  return `${QUICKCHART_BASE_URL}?text=${encodedPayload}&size=1200&margin=2&ecLevel=Q`;
}

function toPrintableWorldSlug(worldId: string): string {
  const slug = worldId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return slug.length > 0 ? slug : DEFAULT_WORLD_ID;
}

export class FpsphereQrPrintApp {
  private readonly rootNode: HTMLDivElement;
  private readonly worldIdInput: HTMLInputElement;
  private readonly markerSizeInput: HTMLInputElement;
  private readonly worldScaleInput: HTMLInputElement;
  private readonly payloadValueNode: HTMLElement;
  private readonly previewTitleNode: HTMLHeadingElement;
  private readonly previewMetaNode: HTMLParagraphElement;
  private readonly previewImageNode: HTMLImageElement;
  private readonly statusNode: HTMLParagraphElement;

  constructor(private readonly mountNode: HTMLDivElement) {
    this.mountNode.innerHTML = "";

    this.rootNode = document.createElement("div");
    this.rootNode.className = "qr-root";
    this.mountNode.appendChild(this.rootNode);

    const panelNode = document.createElement("section");
    panelNode.className = "qr-panel";
    this.rootNode.appendChild(panelNode);

    const headingNode = document.createElement("h1");
    headingNode.textContent = "FPSphere QR Marker Printer";
    panelNode.appendChild(headingNode);

    const introNode = document.createElement("p");
    introNode.className = "qr-intro";
    introNode.textContent =
      "Generate a printable QR marker that maps to a specific FPSphere world.";
    panelNode.appendChild(introNode);

    const worldLabel = document.createElement("label");
    worldLabel.className = "qr-label";
    worldLabel.textContent = "World ID";
    panelNode.appendChild(worldLabel);

    this.worldIdInput = document.createElement("input");
    this.worldIdInput.className = "qr-input";
    this.worldIdInput.type = "text";
    this.worldIdInput.placeholder = DEFAULT_WORLD_ID;
    this.worldIdInput.value =
      new URLSearchParams(window.location.search).get("world") ?? DEFAULT_WORLD_ID;
    panelNode.appendChild(this.worldIdInput);

    const sizeLabel = document.createElement("label");
    sizeLabel.className = "qr-label";
    sizeLabel.textContent = "Printed marker size (mm)";
    panelNode.appendChild(sizeLabel);

    this.markerSizeInput = document.createElement("input");
    this.markerSizeInput.className = "qr-input";
    this.markerSizeInput.type = "number";
    this.markerSizeInput.min = "40";
    this.markerSizeInput.max = "450";
    this.markerSizeInput.step = "1";
    this.markerSizeInput.value = String(Math.round(DEFAULT_MARKER_SIZE_METERS * 1000));
    panelNode.appendChild(this.markerSizeInput);

    const worldScaleLabel = document.createElement("label");
    worldScaleLabel.className = "qr-label";
    worldScaleLabel.textContent = "AR world scale multiplier";
    panelNode.appendChild(worldScaleLabel);

    this.worldScaleInput = document.createElement("input");
    this.worldScaleInput.className = "qr-input";
    this.worldScaleInput.type = "number";
    this.worldScaleInput.min = "0.25";
    this.worldScaleInput.max = "6";
    this.worldScaleInput.step = "0.1";
    const scaleParam = new URLSearchParams(window.location.search).get("scale");
    const queryScale = scaleParam === null ? Number.NaN : Number(scaleParam);
    const startScale = clampWorldScaleMultiplier(
      Number.isFinite(queryScale) ? queryScale : DEFAULT_WORLD_SCALE_MULTIPLIER,
    );
    this.worldScaleInput.value = String(startScale);
    panelNode.appendChild(this.worldScaleInput);

    const payloadLabel = document.createElement("p");
    payloadLabel.className = "qr-label";
    payloadLabel.textContent = "Marker payload";
    panelNode.appendChild(payloadLabel);

    this.payloadValueNode = document.createElement("code");
    this.payloadValueNode.className = "qr-payload";
    panelNode.appendChild(this.payloadValueNode);

    const controlsNode = document.createElement("div");
    controlsNode.className = "qr-controls";
    panelNode.appendChild(controlsNode);

    const printButton = document.createElement("button");
    printButton.className = "qr-button";
    printButton.type = "button";
    printButton.textContent = "Print";
    printButton.addEventListener("click", () => {
      window.print();
    });
    controlsNode.appendChild(printButton);

    const copyPayloadButton = document.createElement("button");
    copyPayloadButton.className = "qr-button qr-button-secondary";
    copyPayloadButton.type = "button";
    copyPayloadButton.textContent = "Copy payload";
    copyPayloadButton.addEventListener("click", () => {
      void this.copyPayloadToClipboard();
    });
    controlsNode.appendChild(copyPayloadButton);

    const downloadButton = document.createElement("button");
    downloadButton.className = "qr-button qr-button-secondary";
    downloadButton.type = "button";
    downloadButton.textContent = "Download PNG";
    downloadButton.addEventListener("click", () => {
      this.downloadMarkerImage();
    });
    controlsNode.appendChild(downloadButton);

    const openArLink = document.createElement("a");
    openArLink.className = "qr-link";
    openArLink.href = "/?mode=ar";
    openArLink.textContent = "Open AR viewer";
    panelNode.appendChild(openArLink);

    const backLink = document.createElement("a");
    backLink.className = "qr-link";
    backLink.href = "/";
    backLink.textContent = "Open FPS client";
    panelNode.appendChild(backLink);

    this.statusNode = document.createElement("p");
    this.statusNode.className = "qr-status";
    panelNode.appendChild(this.statusNode);

    const previewNode = document.createElement("section");
    previewNode.className = "qr-preview";
    this.rootNode.appendChild(previewNode);

    this.previewTitleNode = document.createElement("h2");
    previewNode.appendChild(this.previewTitleNode);

    this.previewMetaNode = document.createElement("p");
    this.previewMetaNode.className = "qr-preview-meta";
    previewNode.appendChild(this.previewMetaNode);

    this.previewImageNode = document.createElement("img");
    this.previewImageNode.className = "qr-preview-image";
    this.previewImageNode.alt = "FPSphere QR marker preview";
    previewNode.appendChild(this.previewImageNode);
  }

  start(): void {
    this.worldIdInput.addEventListener("input", this.updatePreview);
    this.markerSizeInput.addEventListener("input", this.updatePreview);
    this.worldScaleInput.addEventListener("input", this.updatePreview);
    this.updatePreview();
  }

  private readonly updatePreview = (): void => {
    const worldId = this.worldIdInput.value.trim() || DEFAULT_WORLD_ID;
    const markerSizeMillimeters = Number(this.markerSizeInput.value);
    const markerSizeMeters = clampMarkerSizeMeters(markerSizeMillimeters / 1000);
    const markerSizeRoundedMillimeters = Math.round(markerSizeMeters * 1000);
    this.markerSizeInput.value = String(markerSizeRoundedMillimeters);
    const worldScaleMultiplier = clampWorldScaleMultiplier(
      Number(this.worldScaleInput.value),
    );
    this.worldScaleInput.value = String(worldScaleMultiplier);

    const payload = buildMarkerPayload(
      worldId,
      markerSizeMeters,
      worldScaleMultiplier,
    );
    const qrImageUrl = buildQrImageUrl(payload);

    this.payloadValueNode.textContent = payload;
    this.previewTitleNode.textContent = `World ${worldId}`;
    this.previewMetaNode.textContent =
      `Marker size: ${markerSizeRoundedMillimeters} mm | world scale: ${worldScaleMultiplier}x`;
    this.previewImageNode.src = qrImageUrl;
    this.previewImageNode.alt = `QR marker for world ${worldId}`;
    this.statusNode.textContent =
      "Print at 100% scale. In AR mode, hold the phone so the full marker stays in frame.";
  };

  private async copyPayloadToClipboard(): Promise<void> {
    const payload = this.payloadValueNode.textContent ?? "";
    if (payload.length === 0) {
      return;
    }

    if (!navigator.clipboard?.writeText) {
      this.statusNode.textContent =
        "Clipboard API unavailable in this browser. Copy the payload manually.";
      return;
    }

    try {
      await navigator.clipboard.writeText(payload);
      this.statusNode.textContent = "Payload copied.";
    } catch {
      this.statusNode.textContent = "Failed to copy payload.";
    }
  }

  private downloadMarkerImage(): void {
    const worldId = this.worldIdInput.value.trim() || DEFAULT_WORLD_ID;
    const markerHref = this.previewImageNode.src;
    if (markerHref.length === 0) {
      return;
    }

    const linkNode = document.createElement("a");
    linkNode.href = markerHref;
    linkNode.download = `fpsphere-marker-${toPrintableWorldSlug(worldId)}.png`;
    linkNode.click();
  }
}
