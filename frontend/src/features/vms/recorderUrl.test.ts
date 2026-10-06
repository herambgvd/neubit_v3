import { describe, expect, it } from "vitest";
import { normalizeApiUrl } from "./recorderUrl";

// SCRUM-302: the API URL is the recorder console's address, and operators paste it
// from the browser bar, page and all.
describe("normalizeApiUrl", () => {
  it("keeps a plain console address", () => {
    expect(normalizeApiUrl("http://192.168.1.11:8080")).toBe("http://192.168.1.11:8080");
    expect(normalizeApiUrl("  https://nvr-a.site.local:8443/ ")).toBe("https://nvr-a.site.local:8443");
  });

  it("drops the console page an address was copied from", () => {
    expect(normalizeApiUrl("http://192.168.1.11:8080/config?section=federation")).toBe("http://192.168.1.11:8080");
    expect(normalizeApiUrl("http://192.168.1.11:8080/login")).toBe("http://192.168.1.11:8080");
    expect(normalizeApiUrl("http://192.168.1.11:8080/live#wall")).toBe("http://192.168.1.11:8080");
  });

  it("keeps a reverse-proxy path prefix", () => {
    expect(normalizeApiUrl("https://gw.example.com/recorders/a/")).toBe("https://gw.example.com/recorders/a");
  });

  it("refuses what is not an http(s) address", () => {
    expect(normalizeApiUrl("192.168.1.11:8080")).toBeNull();
    expect(normalizeApiUrl("rtsp://192.168.1.11:8554")).toBeNull();
    expect(normalizeApiUrl("http://")).toBeNull();
    expect(normalizeApiUrl("")).toBeNull();
  });
});
