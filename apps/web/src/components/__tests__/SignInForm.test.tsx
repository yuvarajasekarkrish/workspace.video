import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SignInForm } from "../SignInForm";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const fetchMock = vi.fn();

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const emailInput = () => screen.getByLabelText(/email/i) as HTMLInputElement;
const submitButton = () => screen.getByRole("button", { name: /email me a link/i }) as HTMLButtonElement;
function submit(email: string) {
  fireEvent.change(emailInput(), { target: { value: email } });
  fireEvent.click(submitButton());
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  push.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("SignInForm: asking for a link", () => {
  it("has a visible label for the email field, not only a placeholder", () => {
    render(<SignInForm />);
    expect(emailInput().getAttribute("type")).toBe("email");
    expect(emailInput().required).toBe(true);
  });

  it("posts the address to the sign-in endpoint and sends the person home afterwards", async () => {
    fetchMock.mockReturnValue(reply(200, { status: true }));
    render(<SignInForm />);
    submit("ana@example.com");
    await screen.findByText(/check your email/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/sign-in/magic-link");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "ana@example.com", callbackURL: "/" });
  });

  it("confirms the address it sent to, says the link works once and expires, and offers a different address", async () => {
    fetchMock.mockReturnValue(reply(200, { status: true }));
    render(<SignInForm />);
    submit("ana@example.com");
    await screen.findByText(/check your email/i);
    expect(screen.getByText(/ana@example\.com/)).toBeTruthy();
    expect(screen.getByText(/once/i)).toBeTruthy();
    expect(screen.getByText(/15 minutes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /different email/i }));
    expect(emailInput().value).toBe("");
  });

  it("disables the button while the request is in flight, so a double click sends one request", async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
    render(<SignInForm />);
    submit("ana@example.com");
    const button = screen.getByRole("button", { name: /sending/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(new Response(JSON.stringify({ status: true }), { status: 200 }));
    await screen.findByText(/check your email/i);
  });
});

describe("SignInForm: when it goes wrong, it says what to do", () => {
  it("asks for a valid address when the server rejects one the browser accepted (400 validation error)", async () => {
    fetchMock.mockReturnValue(reply(400, { code: "VALIDATION_ERROR", message: "[body.email] Invalid email address" }));
    render(<SignInForm />);
    submit("a@b"); // passes the browser's own check, fails the server's
    expect((await screen.findByRole("alert")).textContent).toMatch(/valid email/i);
  });

  it("shows the server's message on 429 (too many requests)", async () => {
    fetchMock.mockReturnValue(reply(429, { error: "too_many_requests", message: "Too many sign-in requests for this address. Please try again in a few minutes." }));
    render(<SignInForm />);
    submit("ana@example.com");
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many/i);
  });

  it("shows the server's message on 503 (the email could not be sent)", async () => {
    fetchMock.mockReturnValue(reply(503, { error: "send_failed", message: "We couldn't send the link. Please try again in a moment." }));
    render(<SignInForm />);
    submit("ana@example.com");
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn.t send/i);
  });

  it("gives a generic message for an unexpected reply that is not JSON", async () => {
    fetchMock.mockReturnValue(reply(500, "<html>oops</html>"));
    render(<SignInForm />);
    submit("ana@example.com");
    expect((await screen.findByRole("alert")).textContent).toMatch(/something went wrong/i);
  });

  it("says so when the server cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<SignInForm />);
    submit("ana@example.com");
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn.t reach/i);
  });

  it("re-enables the form after an error so the person can try again", async () => {
    fetchMock.mockReturnValue(reply(503, { message: "We couldn't send the link. Please try again in a moment." }));
    render(<SignInForm />);
    submit("ana@example.com");
    await screen.findByRole("alert");
    expect(submitButton().disabled).toBe(false);
    expect(emailInput().value).toBe("ana@example.com");
  });
});

describe("SignInForm: the dev sign-in", () => {
  it("is not shown unless devAuth is on", () => {
    render(<SignInForm />);
    expect(screen.queryByText(/dev sign-in/i)).toBeNull();
  });

  it("when devAuth is on, signs a seeded user in without email and reloads", async () => {
    fetchMock.mockReturnValue(reply(200, { ok: true }));
    render(<SignInForm devAuth />);
    expect(screen.getByText(/dev sign-in/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^sign in as$/i }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/dev-signin");
    expect(JSON.parse(init.body)).toEqual({ email: "test@example.com" });
    expect(push).toHaveBeenCalledWith("/");
  });

  it("shows the reason when the dev sign-in is refused", async () => {
    fetchMock.mockReturnValue(reply(401, { error: "No such seeded user." }));
    render(<SignInForm devAuth />);
    fireEvent.click(screen.getByRole("button", { name: /^sign in as$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no such seeded user/i);
  });
});
