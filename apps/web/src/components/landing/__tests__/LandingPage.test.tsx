import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { LandingPage } from "../LandingPage";

// The landing page is the owner's Gemini design (docs/designs/gemini-landing.html.html), ported
// as it was drawn: five screens (home, the 2.5D map, an instant space, pricing, sign in) that
// switch in place. The only real functions are the email sign-in and the legal line.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));

function nav() {
  return screen.getByRole("navigation", { name: /main/i });
}
function openMap() {
  fireEvent.click(within(nav()).getByRole("link", { name: /launch workspace/i }));
}
function sceneScale() {
  return screen.getByTestId("scene").style.transform;
}

describe("LandingPage: home screen, as in the Gemini design", () => {
  it("has the top bar: logo, Spatial Map, Instant Space, Pricing, Admin Builder, Sign in, Launch Workspace", () => {
    render(<LandingPage />);
    const bar = within(nav());
    for (const name of [/spatial map/i, /instant space/i, /^pricing$/i, /sign in/i, /launch workspace/i]) {
      expect(bar.getByRole("link", { name })).toBeTruthy();
    }
    expect(bar.getByRole("button", { name: /admin builder/i })).toBeTruthy();
    expect(bar.getByText("workspace")).toBeTruthy();
  });

  it("has the announcement pill, the gradient headline, the support line and the two buttons", () => {
    render(<LandingPage />);
    expect(screen.getByText(/now supporting up to 200 users per workspace/i)).toBeTruthy();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("A lightweight spatial layer for remote work.");
    expect(h1.className).toMatch(/text-transparent/);
    expect(h1.className).toMatch(/bg-clip-text/);
    expect(h1.className).toMatch(/bg-gradient-to-br/);
    expect(screen.getByText(/see where your team is, drop into focus desks/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /explore the 200-user map/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /open admin builder/i })).toBeTruthy();
  });

  it("keeps the real email sign-in box under the buttons, with the Terms and Privacy line", () => {
    render(<LandingPage />);
    expect(screen.getByLabelText(/work email/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^get started$/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^terms$/i }).getAttribute("href")).toBe("/terms");
    expect(screen.getByRole("link", { name: /^privacy policy$/i }).getAttribute("href")).toBe("/privacy");
  });

  it("shows the notice when a sign-in link has expired", () => {
    render(<LandingPage notice="That link has expired or was already used. Enter your email to get a new one." />);
    expect(screen.getByRole("alert").textContent).toMatch(/expired or was already used/i);
  });

  it("uses Inter, self-hosted", () => {
    const css = readFileSync(join(here, "../../../app/globals.css"), "utf8");
    expect(css).toMatch(/@import "@fontsource-variable\/inter"/);
    expect(css).toMatch(/--font-sans:\s*"Inter Variable"/);
    expect(css).not.toMatch(/fonts\.googleapis/);
  });
});

describe("LandingPage: the 2.5D map screen", () => {
  it("opens from Launch Workspace with the nine areas, people, and the header panel", () => {
    render(<LandingPage />);
    openMap();
    expect(screen.getByTestId("scene").querySelectorAll("[data-zone]")).toHaveLength(9);
    expect(screen.getByTestId("scene").querySelectorAll("[data-person]").length).toBeGreaterThan(20);
    expect(screen.getByTestId("scene").querySelector("[data-you]")).toBeTruthy();
    expect(screen.getByText("Global Headquarters")).toBeTruthy();
    expect(screen.getByText("Architectural Floor Plan")).toBeTruthy();
    expect(screen.getByText("online")).toBeTruthy();
  });

  it("opens from the hero button too", () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole("button", { name: /explore the 200-user map/i }));
    expect(screen.getByTestId("scene")).toBeTruthy();
  });

  it("has an admin builder that adds an area and resets", () => {
    render(<LandingPage />);
    openMap();
    fireEvent.click(within(nav()).getByRole("button", { name: /admin builder/i }));
    const panel = screen.getByText(/admin spatial builder/i).closest("div")!.parentElement!;
    expect(within(panel).getByText(/total active zones/i).textContent).toMatch(/9/);
    fireEvent.click(within(panel).getByRole("button", { name: /add meeting room/i }));
    expect(screen.getByTestId("scene").querySelectorAll("[data-zone]")).toHaveLength(10);
    expect(within(panel).getByText(/total active zones/i).textContent).toMatch(/10/);
    fireEvent.click(within(panel).getByRole("button", { name: /reset map/i }));
    expect(screen.getByTestId("scene").querySelectorAll("[data-zone]")).toHaveLength(9);
  });

  it("opens the admin builder on the map when pressed from the home screen", () => {
    render(<LandingPage />);
    fireEvent.click(screen.getByRole("button", { name: /open admin builder/i }));
    expect(screen.getByTestId("scene")).toBeTruthy();
    expect(screen.getByText(/admin spatial builder/i)).toBeTruthy();
  });

  it("zooms in and out in steps of 0.05, resets, and stays between 0.15 and 1", () => {
    render(<LandingPage />);
    openMap();
    expect(sceneScale()).toMatch(/scale\(0\.35\)/);
    const zoomIn = screen.getByRole("button", { name: /zoom in/i });
    fireEvent.click(zoomIn);
    fireEvent.click(zoomIn);
    expect(sceneScale()).toMatch(/scale\(0\.45\)/);
    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    expect(sceneScale()).toMatch(/scale\(0\.35\)/);
    const zoomOut = screen.getByRole("button", { name: /zoom out/i });
    for (let i = 0; i < 10; i++) fireEvent.click(zoomOut);
    expect(sceneScale()).toMatch(/scale\(0\.15\)/);
    for (let i = 0; i < 30; i++) fireEvent.click(zoomIn);
    expect(sceneScale()).toMatch(/scale\(1\)/);
  });

  it("does not reshuffle the people while the map is dragged", () => {
    render(<LandingPage />);
    openMap();
    const viewport = screen.getByTestId("scene").parentElement!;
    const before = screen.getByTestId("scene").innerHTML;
    fireEvent.mouseDown(viewport, { clientX: 10, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 60, clientY: 40 });
    fireEvent.mouseUp(window);
    expect(screen.getByTestId("scene").style.getPropertyValue("--tx")).toBe("50px");
    expect(screen.getByTestId("scene").style.getPropertyValue("--ty")).toBe("30px");
    expect(screen.getByTestId("scene").innerHTML).toBe(before);
  });

  it("removes every window listener it added when the map closes and when the page unmounts", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    const add = vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      added.push(type);
      realAdd(type, listener, options);
    });
    const remove = vi.spyOn(window, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removed.push(type);
      realRemove(type, listener, options);
    });
    try {
      const view = render(<LandingPage />);
      openMap();
      fireEvent.click(within(nav()).getByRole("link", { name: /^pricing$/i }));
      view.unmount();
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
    for (const type of ["mousemove", "mouseup"]) {
      expect(added.filter((t) => t === type).length, `${type} added`).toBeGreaterThan(0);
      expect(removed.filter((t) => t === type).length, `${type} removed`).toBe(added.filter((t) => t === type).length);
    }
  });
});

describe("LandingPage: the other screens", () => {
  it("shows an instant space with a way back to the map", () => {
    render(<LandingPage />);
    fireEvent.click(within(nav()).getByRole("link", { name: /instant space/i }));
    expect(screen.getByRole("heading", { name: /design studio - sync/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /leave space/i }));
    expect(screen.getByTestId("scene")).toBeTruthy();
  });

  it("shows pricing, and its button opens the map", () => {
    render(<LandingPage />);
    fireEvent.click(within(nav()).getByRole("link", { name: /^pricing$/i }));
    expect(screen.getByRole("heading", { name: /simple, transparent pricing/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /get started free/i }));
    expect(screen.getByTestId("scene")).toBeTruthy();
  });

  it("shows the real email sign-in on the sign-in screen, not a button that skips it", () => {
    render(<LandingPage />);
    fireEvent.click(within(nav()).getByRole("link", { name: /sign in/i }));
    expect(screen.getByRole("heading", { name: /welcome back/i })).toBeTruthy();
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.queryByTestId("scene")).toBeNull();
  });

  it("goes home from the logo", () => {
    render(<LandingPage />);
    openMap();
    fireEvent.click(within(nav()).getByRole("link", { name: /^workspace\.video$/i }));
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
  });
});
