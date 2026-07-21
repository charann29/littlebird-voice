/**
 * ConnectionsSettings tests (40-T3/T4 client slice): provider cards render
 * for all four providers with status badges; Connect POSTs /connect and
 * navigates to authorizeUrl; Disconnect DELETEs and refreshes; error status
 * surfaces Reconnect; ?connected/?error OAuth-return banner; offline and
 * no-token degradation (disabled actions, no error wall); no token material
 * ever rendered.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    apiFetch: (path: string, init?: RequestInit) => apiFetchMock(path, init),
  };
});

import { setApiToken } from "../lib/api";
import { ConnectionsSettings } from "./ConnectionsSettings";

const ALL_DISCONNECTED = {
  providers: [
    { provider: "google-calendar", connected: false },
    { provider: "gmail", connected: false },
    { provider: "slack", connected: false },
    { provider: "notion", connected: false },
  ],
};

function renderAt(path = "/settings/connections") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ConnectionsSettings />
    </MemoryRouter>,
  );
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setApiToken("test-token");
  setOnline(true);
  apiFetchMock.mockReset();
});

describe("ConnectionsSettings", () => {
  it("renders all four provider cards from the list endpoint", async () => {
    apiFetchMock.mockResolvedValue({
      providers: [
        {
          provider: "google-calendar",
          connected: true,
          status: "active",
          displayName: "user@example.com",
          connectedAt: 1750000000000,
        },
        { provider: "gmail", connected: false },
        { provider: "slack", connected: false },
        { provider: "notion", connected: false },
      ],
    });
    renderAt();

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        "/integrations",
        expect.anything(),
      ),
    );

    const calendar = await screen.findByTestId(
      "provider-card-google-calendar",
    );
    expect(within(calendar).getByText("Connected")).toBeInTheDocument();
    expect(within(calendar).getByText("user@example.com")).toBeInTheDocument();
    expect(
      within(calendar).getByRole("button", { name: /Disconnect/ }),
    ).toBeInTheDocument();

    for (const slug of ["gmail", "slack", "notion"]) {
      const card = screen.getByTestId(`provider-card-${slug}`);
      expect(within(card).getByText("Not connected")).toBeInTheDocument();
      expect(
        within(card).getByRole("button", { name: /Connect/ }),
      ).toBeEnabled();
    }
  });

  it("Connect POSTs /connect and navigates to the authorizeUrl", async () => {
    const user = userEvent.setup();
    const assignMock = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      assign: assignMock,
    } as unknown as Location);

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === "/integrations") return ALL_DISCONNECTED;
      if (path === "/integrations/slack/connect") {
        return { authorizeUrl: "https://slack.com/oauth/v2/authorize?x=1" };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderAt();

    const card = await screen.findByTestId("provider-card-slack");
    await user.click(within(card).getByRole("button", { name: /Connect/ }));

    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "https://slack.com/oauth/v2/authorize?x=1",
      ),
    );
    const connectCall = apiFetchMock.mock.calls.find(
      ([p]) => p === "/integrations/slack/connect",
    );
    expect(connectCall?.[1]?.method).toBe("POST");
    expect(JSON.parse(connectCall?.[1]?.body as string)).toEqual({
      redirectTo: "/settings/connections",
    });
  });

  it("Disconnect DELETEs the provider and refreshes the list", async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    apiFetchMock.mockImplementation(
      async (path: string, init?: RequestInit) => {
        if (path === "/integrations" && init?.method === undefined) {
          listCalls += 1;
          return listCalls === 1
            ? {
                providers: [
                  {
                    provider: "notion",
                    connected: true,
                    status: "active",
                    displayName: "My Workspace",
                  },
                ],
              }
            : ALL_DISCONNECTED;
        }
        if (path === "/integrations/notion" && init?.method === "DELETE") {
          return { ok: true };
        }
        throw new Error(`unexpected ${path}`);
      },
    );
    renderAt();

    const card = await screen.findByTestId("provider-card-notion");
    await user.click(
      within(card).getByRole("button", { name: /Disconnect/ }),
    );

    await waitFor(() =>
      expect(
        within(screen.getByTestId("provider-card-notion")).getByText(
          "Not connected",
        ),
      ).toBeInTheDocument(),
    );
    expect(listCalls).toBe(2); // initial + post-disconnect refresh
  });

  it("status='error' surfaces Needs reconnect + a Reconnect button", async () => {
    apiFetchMock.mockResolvedValue({
      providers: [
        {
          provider: "gmail",
          connected: true,
          status: "error",
          displayName: "user@example.com",
        },
      ],
    });
    renderAt();

    const card = await screen.findByTestId("provider-card-gmail");
    await waitFor(() =>
      expect(within(card).getByText("Needs reconnect")).toBeInTheDocument(),
    );
    expect(
      within(card).getByRole("button", { name: /Reconnect/ }),
    ).toBeEnabled();
    // Action affordances are hidden until reconnected.
    expect(
      within(card).queryByRole("button", { name: /Send via Gmail/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the ?connected= OAuth return banner and strips the param", async () => {
    apiFetchMock.mockResolvedValue(ALL_DISCONNECTED);
    renderAt("/settings/connections?connected=notion");

    const banner = await screen.findByTestId("oauth-return-banner");
    expect(banner).toHaveTextContent("Notion connected");
  });

  it("shows the ?error= OAuth return banner", async () => {
    apiFetchMock.mockResolvedValue(ALL_DISCONNECTED);
    renderAt("/settings/connections?error=state_expired");

    const banner = await screen.findByTestId("oauth-return-banner");
    expect(banner).toHaveTextContent("Connection failed (state_expired)");
  });

  it("degrades gracefully offline: cards render, actions disabled, no requests", async () => {
    setOnline(false);
    renderAt();

    expect(
      screen.getByText(/You're offline — connections are read-only/),
    ).toBeInTheDocument();
    for (const slug of ["google-calendar", "gmail", "slack", "notion"]) {
      const card = screen.getByTestId(`provider-card-${slug}`);
      expect(
        within(card).getByRole("button", { name: /Connect/ }),
      ).toBeDisabled();
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully without an API token: points at Settings", async () => {
    setApiToken(null);
    renderAt();

    expect(screen.getByText(/Set your API token in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("never renders token material even if the server over-returns", async () => {
    apiFetchMock.mockResolvedValue({
      providers: [
        {
          provider: "slack",
          connected: true,
          status: "active",
          displayName: "Acme Workspace",
        },
      ],
    });
    const { container } = renderAt();
    await screen.findByText("Acme Workspace");
    expect(container.innerHTML).not.toMatch(/xoxb|access_token|refresh_token/);
  });
});
