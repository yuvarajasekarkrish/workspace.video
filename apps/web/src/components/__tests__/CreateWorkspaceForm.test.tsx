import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PLAN_IDS, PLAN_LABELS, PLAN_PARTICIPANT_LIMITS, DEFAULT_LAYOUT_ID, listLayoutIds } from "@workspace-video/shared";
import { CreateWorkspaceForm } from "../CreateWorkspaceForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe("CreateWorkspaceForm", () => {
  afterEach(cleanup);

  it("renders one card per plan with its participant limit", () => {
    render(<CreateWorkspaceForm />);

    for (const id of PLAN_IDS) {
      expect(screen.getByText(PLAN_LABELS[id])).toBeTruthy();
      expect(screen.getByText(String(PLAN_PARTICIPANT_LIMITS[id]))).toBeTruthy();
    }
  });

  it("selects startup by default and switches selection on click", () => {
    render(<CreateWorkspaceForm />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(PLAN_IDS.length);

    const startup = screen.getByText(PLAN_LABELS.startup).closest("button")!;
    expect(startup.getAttribute("aria-checked")).toBe("true");

    const enterprise = screen.getByText(PLAN_LABELS.enterprise).closest("button")!;
    fireEvent.click(enterprise);
    expect(enterprise.getAttribute("aria-checked")).toBe("true");
    expect(startup.getAttribute("aria-checked")).toBe("false");
  });

  it("offers every registered template, defaults to office300@1, and sends the chosen one", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ roomId: "r1" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CreateWorkspaceForm />);

    const select = screen.getByLabelText(/office template/i) as HTMLSelectElement;
    expect(select.value).toBe(DEFAULT_LAYOUT_ID);
    expect([...select.options].map((o) => o.value)).toEqual(listLayoutIds());

    fireEvent.change(select, { target: { value: "cosmicCampus100@1" } });
    fireEvent.change(screen.getByLabelText(/workspace name/i), { target: { value: "Nova" } });
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ name: "Nova", plan: "startup", layoutId: "cosmicCampus100@1" });
    vi.unstubAllGlobals();
  });

  it("disables submit until a name is entered", () => {
    render(<CreateWorkspaceForm />);
    const submit = screen.getByRole("button", { name: /create workspace/i });
    expect(submit.hasAttribute("disabled")).toBe(true);
  });
});
