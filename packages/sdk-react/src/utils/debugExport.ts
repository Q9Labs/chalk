export type PreparedDebugExport = any;
export type DebugCopyResult = any;
export function buildDebugExport(..._args: any[]): any {
  return null;
}
export function downloadDebugExport(..._args: any[]): void {}
export function prepareFullDebugExport(..._args: any[]): Promise<any> {
  return Promise.resolve({ text: "", fileName: "chalk-debug.txt", diagnostics: {}, report: {} });
}
export function downloadDebugText(..._args: any[]): void {}
export function copyPreparedDebugExport(..._args: any[]): Promise<any> {
  return Promise.resolve({ outcome: "noop", diagnostics: {} });
}
export function downloadDebugReport(..._args: any[]): void {}
export function copyDebugTextToClipboard(..._args: any[]): Promise<any> {
  return Promise.resolve({ outcome: "noop" });
}
export function exportFullDebugReport(..._args: any[]): Promise<any> {
  return Promise.resolve(null);
}
export function toDebugClipboardText(..._args: any[]): string {
  return "";
}
