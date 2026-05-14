const DOCS_BASE_URL = "https://docs.chalk.q9labs.ai";

export function getDocsExternalUrl(pathname: string, search = "", hash = ""): string {
  const normalizedPathname = pathname.startsWith("/documentation")
    ? pathname.slice("/documentation".length)
    : pathname.startsWith("/docs")
      ? pathname.slice("/docs".length)
      : pathname;
  const normalizedPath = normalizedPathname === "" ? "" : normalizedPathname.startsWith("/") ? normalizedPathname : `/${normalizedPathname}`;

  return `${DOCS_BASE_URL}${normalizedPath}${search}${hash}`;
}

export function isLegacyDocsPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/") || pathname === "/documentation" || pathname.startsWith("/documentation/");
}

export function redirectToExternalDocs(pathname: string, search = "", hash = ""): void {
  window.location.replace(getDocsExternalUrl(pathname, search, hash));
}

export { DOCS_BASE_URL };
