export function shouldShowWhiteboardRendererPlayground(input: { readonly isDevRuntime: boolean; readonly routeKind: "home" | "lobby" }): boolean {
  return input.isDevRuntime && input.routeKind === "home";
}
