const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false as const,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
  tools: { image: false },
  welcomeScreen: false,
};

const UPLOAD_UI_OPTIONS = { ...UI_OPTIONS, tools: { image: true } };

export function whiteboardUiOptions(canUpload: boolean) {
  return canUpload ? UPLOAD_UI_OPTIONS : UI_OPTIONS;
}
