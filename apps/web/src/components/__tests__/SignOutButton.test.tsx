import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SignOutButton } from "../SignOutButton";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("SignOutButton", () => {
  it("posts to the sign-out endpoint and reloads so the page shows the signed-out state", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/sign-out");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("is disabled while signing out, so a double click sends one request", async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    render(<SignOutButton />);
    const button = screen.getByRole("button", { name: /sign out/i }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response("{}", { status: 200 }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("does not pretend to have signed out when the request fails, and lets the person retry", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn.t sign out/i);
    expect(refresh).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /sign out/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when the server cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn.t sign out/i);
  });
});
