import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("public discovery files", () => {
  it("routes crawlers and agents to real discovery resources", () => {
    const robots = readPublicText("robots.txt");
    const llms = readPublicText("llms.txt");
    const sitemap = readPublicText("sitemap.xml");
    const redirects = readPublicText("_redirects");
    const headers = readPublicText("_headers");

    expect(robots).toContain("Sitemap: https://chalkmeet.com/sitemap.xml");
    expect(robots).toContain("Disallow: /space");
    expect(llms).toContain("The canonical product documentation is https://chalkmeet.com/docs");
    expect(sitemap).toContain("<loc>https://chalkmeet.com/docs</loc>");
    expect(sitemap).toContain("<loc>https://chalkmeet.com/status</loc>");
    expect(redirects).toContain("/* /_shell.html 200");
    expect(headers).toContain("Content-Type: application/xml; charset=utf-8");
    expect(headers).toContain("X-Robots-Tag: noindex, nofollow, noarchive");
  });

  it("ships the social preview at the declared Open Graph dimensions", () => {
    const socialImage = readFileSync(new URL("../../public/images/social/chalk-og-product-20260819.png", import.meta.url));

    expect(socialImage.readUInt32BE(16)).toBe(1200);
    expect(socialImage.readUInt32BE(20)).toBe(630);
  });
});

function readPublicText(path: string): string {
  return readFileSync(new URL(`../../public/${path}`, import.meta.url), "utf8");
}
