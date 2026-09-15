import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { connectionStore } from "@/store/connectionStore";
import { CapacityScreen } from "../CapacityScreen";

describe("CapacityScreen", () => {
  beforeEach(() => {
    connectionStore.getState().setStatus("idle");
    connectionStore.getState().setCapacity(null);
  });

  // No global cleanup is configured for this project's vitest setup, so
  // each render() here must be explicitly unmounted or later tests in this
  // file see duplicate elements from earlier renders still in the DOM.
  afterEach(cleanup);

  it("renders nothing when status isn't workspace_full", () => {
    connectionStore.getState().setStatus("connected");
    const { container } = render(<CapacityScreen onRetry={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the active/limit numbers from the join_room ack", () => {
    connectionStore.getState().setStatus("workspace_full");
    connectionStore.getState().setCapacity({ active: 10, limit: 10 });

    render(<CapacityScreen onRetry={() => {}} />);

    expect(screen.getByText("10 / 10")).toBeTruthy();
  });

  it("calls onRetry when the button is clicked", async () => {
    connectionStore.getState().setStatus("workspace_full");
    connectionStore.getState().setCapacity({ active: 5, limit: 5 });

    let retried = false;
    render(<CapacityScreen onRetry={() => (retried = true)} />);

    screen.getByRole("button", { name: /try again/i }).click();
    expect(retried).toBe(true);
  });
});
