import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WelcomeEmptyState } from "../WelcomeEmptyState";
import { NoRoomAccess } from "../NoRoomAccess";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

describe("WelcomeEmptyState (a signed-in person with no workspace yet)", () => {
  it("welcomes them and offers one clear action", () => {
    render(<WelcomeEmptyState />);
    expect(screen.getByRole("heading", { name: /welcome/i })).toBeTruthy();
    const create = screen.getByRole("link", { name: /create your workspace/i });
    expect(create.getAttribute("href")).toBe("/workspaces/new");
  });

  it("covers the person who was invited, in plain words", () => {
    render(<WelcomeEmptyState />);
    expect(screen.getByText(/invited\?.*invite link/i)).toBeTruthy();
  });

  it("has no developer wording", () => {
    const { container } = render(<WelcomeEmptyState />);
    expect(container.textContent).not.toMatch(/seed|script|pnpm|db /i);
  });
});

describe("NoRoomAccess (signed in, but not a member of this room)", () => {
  it("says who they are signed in as and what to try, without saying whether the room exists", () => {
    const { container } = render(<NoRoomAccess email="ana@example.com" />);
    expect(screen.getByRole("heading", { name: /don't have access/i })).toBeTruthy();
    expect(screen.getByText(/ana@example\.com/)).toBeTruthy();
    expect(container.textContent).toMatch(/different address/i);
    expect(container.textContent).not.toMatch(/does not exist|doesn't exist|not found/i);
  });

  it("offers a way to sign out and a way back to their workspaces", () => {
    render(<NoRoomAccess email="ana@example.com" />);
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /go to my workspaces/i }).getAttribute("href")).toBe("/");
  });
});
