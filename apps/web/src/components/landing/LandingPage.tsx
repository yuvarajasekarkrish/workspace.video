"use client";

import "./landing.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { SignInForm } from "../SignInForm";
import { DevSignInForm } from "../DevSignInForm";

/**
 * The signed-out landing page: the owner's Gemini design (docs/designs/gemini-landing.html.html),
 * ported as it was drawn. It has five screens that switch in place (home, the 2.5D map, an instant
 * space, pricing, sign in), and the words, colours and shapes are Gemini's.
 *
 * Two real parts were added so nothing breaks: the email sign-in (a box on the home screen and on
 * the sign-in screen, in place of a button that skipped signing in) and the Terms and Privacy line.
 *
 * The map builds its people with Math.random, as the original did. That is safe here because the
 * map is only drawn after a click in the browser, never on the server.
 */

type View = "home" | "workspace" | "meeting" | "pricing" | "auth";
type Kind = "desks" | "creative" | "hub" | "cafe" | "meeting" | "focus";
type Zone = { id: string; type: Kind; name: string; x: number; y: number; w: number; h: number; targetUsers: number };

const DEFAULT_LAYOUT: Zone[] = [
  { id: "eng", type: "desks", name: "Engineering", x: 200, y: 200, w: 900, h: 500, targetUsers: 45 },
  { id: "prod", type: "desks", name: "Product Team", x: 1250, y: 150, w: 750, h: 450, targetUsers: 30 },
  { id: "design", type: "creative", name: "Design Studio", x: 2150, y: 200, w: 600, h: 650, targetUsers: 20 },
  { id: "sales", type: "desks", name: "Sales & Marketing", x: 200, y: 850, w: 850, h: 450, targetUsers: 35 },
  { id: "hub", type: "hub", name: "Welcome Plaza", x: 1200, y: 700, w: 750, h: 650, targetUsers: 24 },
  { id: "cafe", type: "cafe", name: "Main Lounge", x: 2050, y: 950, w: 700, h: 650, targetUsers: 20 },
  { id: "meet_1", type: "meeting", name: "Boardroom", x: 200, y: 1450, w: 400, h: 400, targetUsers: 8 },
  { id: "meet_2", type: "meeting", name: "Sync A", x: 680, y: 1450, w: 300, h: 300, targetUsers: 4 },
  { id: "focus_pod", type: "focus", name: "Focus Pods", x: 1100, y: 1450, w: 650, h: 350, targetUsers: 14 },
];

const DEFAULT_ZOOM = 0.35;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 1;

/** Steps of 0.05 without the drift of adding floats (0.35 + 0.05 is not exactly 0.4). */
function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
}

// ---------------------------------------------------------------- the map

function Dot({ x, y, name, you = false }: { x: number; y: number; name?: string; you?: boolean }) {
  const speaking = Math.random() > 0.9;
  return (
    <div
      data-person=""
      data-you={you ? "" : undefined}
      className={`gl-user-dot ${you ? "gl-you" : ""} ${speaking ? "gl-speaking" : ""}`}
      style={{ left: x, top: y }}
    >
      {name && <div className="gl-user-name">{name}</div>}
    </div>
  );
}

const CHAIRS: { left: number; bottom: boolean }[] = [
  { left: 35, bottom: false },
  { left: 35, bottom: true },
  { left: 85, bottom: false },
  { left: 85, bottom: true },
];
const SEATS = [
  { x: 43, y: 8 },
  { x: 43, y: 132 },
  { x: 93, y: 8 },
  { x: 93, y: 132 },
];

/** Builds the zones and their furniture and people, and counts the people placed. */
function buildScene(layout: Zone[]): { nodes: ReactNode[]; placed: number } {
  let placed = 0;
  const nodes = layout.map((zone) => {
    let remaining = zone.targetUsers;
    const children: ReactNode[] = [
      <div key="label" className="gl-zone-label">
        {zone.name}
      </div>,
    ];

    if (zone.type === "desks") {
      const cell = 180;
      const cols = Math.floor(zone.w / cell);
      const rows = Math.floor(zone.h / cell);
      const padX = (zone.w - cols * cell) / 2;
      const padY = (zone.h - rows * cell) / 2;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (c % 3 === 2) continue;
          const dots: ReactNode[] = [];
          SEATS.forEach((seat, i) => {
            if (remaining > 0 && Math.random() > 0.4) {
              dots.push(<Dot key={`d${i}`} x={seat.x} y={seat.y} />);
              remaining--;
              placed++;
            }
          });
          children.push(
            <div key={`${r}-${c}`} className="gl-platform" style={{ width: 140, height: 140, left: padX + c * cell + 20, top: padY + r * cell + 20 }}>
              <div className="gl-desk-pod" style={{ left: 0, top: 0 }}>
                <div className="gl-desk-pod-surface" />
                <div className="gl-desk-divider-v" />
                <div className="gl-desk-divider-h" />
                {CHAIRS.map((chair, i) => (
                  <div key={`c${i}`}>
                    <div
                      className="gl-chair"
                      style={{ left: chair.left, ...(chair.bottom ? { bottom: 0, transform: "rotate(180deg)" } : { top: 0 }) }}
                    />
                    <div className="gl-monitor" style={{ left: chair.left + 2, ...(chair.bottom ? { bottom: 22 } : { top: 22 }) }} />
                  </div>
                ))}
              </div>
              {dots}
            </div>,
          );
        }
      }
    } else if (zone.type === "meeting") {
      children.push(
        <div key="table" className="gl-board-table" style={{ width: zone.w * 0.6, height: zone.h * 0.5, left: "20%", top: "25%" }} />,
        <div key="plant" className="gl-plant" style={{ left: "calc(50% - 12px)", top: "calc(50% - 12px)" }} />,
      );
      for (let i = 0; i < remaining; i++) {
        children.push(
          <Dot
            key={`p${i}`}
            x={zone.w * 0.2 + Math.random() * (zone.w * 0.6)}
            y={zone.h * 0.15 + Math.random() * (zone.h * 0.7)}
            name={i === 0 ? "Alex" : undefined}
          />,
        );
        placed++;
      }
    } else if (zone.type === "focus") {
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 4; c++) {
          const pX = 50 + c * 140;
          const pY = 40 + r * 110;
          children.push(
            <div key={`f${r}-${c}`}>
              <div className="gl-focus-pod-desk" style={{ width: 90, height: 70, left: pX, top: pY }} />
              <div className="gl-chair" style={{ left: pX + 36, top: pY + 55 }} />
              <div className="gl-monitor" style={{ left: pX + 37, top: pY + 20 }} />
            </div>,
          );
          if (remaining > 0) {
            children.push(<Dot key={`fd${r}-${c}`} x={pX + 45} y={pY + 60} />);
            remaining--;
            placed++;
          }
        }
      }
    } else if (zone.type === "creative") {
      children.push(<div key="wb" className="gl-whiteboard" style={{ width: 200, height: 8, top: 20, left: 150 }} />);
      for (let c = 0; c < 2; c++) {
        children.push(
          <div key={`dt${c}`} className="gl-drafting-table" style={{ width: 80, height: 60, left: 150 + c * 160, top: 120 }} />,
          <div key={`st${c}`} className="gl-stool" style={{ left: 184 + c * 160, top: 190 }} />,
        );
      }
      for (let i = 0; i < remaining; i++) {
        children.push(<Dot key={`p${i}`} x={100 + Math.random() * (zone.w - 200)} y={100 + Math.random() * (zone.h - 200)} />);
        placed++;
      }
    } else if (zone.type === "cafe") {
      children.push(<div key="bar" className="gl-bar-counter" style={{ width: 350, height: 45, left: 80, top: 60 }} />);
      for (let i = 0; i < 5; i++) {
        children.push(<div key={`s${i}`} className="gl-stool" style={{ left: 100 + i * 70, top: 120 }} />);
      }
      children.push(
        <div key="rug" className="gl-lounge-rug" style={{ width: 280, height: 280, right: 40, bottom: 40 }} />,
        <div key="sofa" className="gl-sofa-curved" style={{ width: 120, height: 120, right: 80, bottom: 80 }} />,
      );
      for (let i = 0; i < remaining; i++) {
        children.push(<Dot key={`p${i}`} x={50 + Math.random() * (zone.w - 100)} y={50 + Math.random() * (zone.h - 100)} />);
        placed++;
      }
    } else if (zone.type === "hub") {
      children.push(
        <div key="rd" className="gl-reception-desk" style={{ width: 160, height: 160, left: 270, top: 50 }} />,
        <Dot key="you" x={330} y={330} name="You" you />,
        <Dot key="priya" x={380} y={290} name="Priya" />,
      );
    }

    return (
      <div
        key={zone.id}
        id={`zone-${zone.id}`}
        data-zone=""
        className={zone.type === "desks" ? "gl-zone-group" : "gl-platform"}
        style={{ left: zone.x, top: zone.y, width: zone.w, height: zone.h }}
      >
        {children}
      </div>
    );
  });
  return { nodes, placed };
}

function MapScreen({
  layout,
  adminOpen,
  onCloseAdmin,
  onAdd,
  onReset,
}: {
  layout: Zone[];
  adminOpen: boolean;
  onCloseAdmin: () => void;
  onAdd: (type: Kind, name: string, targetUsers: number) => void;
  onReset: () => void;
}) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [trans, setTrans] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ active: boolean; startX: number; startY: number }>({ active: false, startX: 0, startY: 0 });
  const transRef = useRef(trans);
  transRef.current = trans;

  // The people are made once per layout, so dragging or zooming does not reshuffle them.
  const scene = useMemo(() => buildScene(layout), [layout]);

  // Listeners on the window exist only while this screen is open, and are removed with it.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onDown = (e: MouseEvent) => {
      drag.current = { active: true, startX: e.clientX - transRef.current.x, startY: e.clientY - transRef.current.y };
    };
    const onMove = (e: MouseEvent) => {
      if (!drag.current.active) return;
      setTrans({ x: e.clientX - drag.current.startX, y: e.clientY - drag.current.startY });
    };
    const stop = () => {
      drag.current.active = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z + (e.deltaY > 0 ? -0.05 : 0.05)));
    };
    viewport.addEventListener("mousedown", onDown);
    viewport.addEventListener("mouseleave", stop);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    return () => {
      viewport.removeEventListener("mousedown", onDown);
      viewport.removeEventListener("mouseleave", stop);
      viewport.removeEventListener("wheel", onWheel);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };
  }, []);

  const sceneStyle = {
    transform: `scale(${zoom}) rotateX(55deg) rotateZ(-45deg)`,
    "--tx": `${trans.x}px`,
    "--ty": `${trans.y}px`,
  } as CSSProperties;

  return (
    <main className="gl-app-view relative h-full flex-1">
      {adminOpen && (
        <div className="gl-glass-panel absolute right-6 top-6 z-[200] flex w-80 flex-col gap-4 rounded-2xl border border-accent/30 p-5 shadow-2xl animate-fade-in">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h3 className="flex items-center gap-2 text-sm font-bold text-accent">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
              Admin Spatial Builder
            </h3>
            <button type="button" onClick={onCloseAdmin} aria-label="Close" className="min-h-11 min-w-11 text-gray-400 hover:text-white">
              &times;
            </button>
          </div>
          <p className="text-xs leading-relaxed text-gray-300">
            Drag or click components to instantly append them to your live 2.5D floor plan.
          </p>
          <div className="flex flex-col gap-2">
            {(
              [
                ["desks", "New Engineering Pod", 45, "+ Add 4-Seater Desk Pod", "Pod"],
                ["meeting", "New Boardroom", 8, "+ Add Meeting Room", "Room"],
                ["creative", "New Design Studio", 12, "+ Add Creative Studio", "Studio"],
                ["cafe", "New Social Lounge", 15, "+ Add Lounge Area", "Lounge"],
              ] as [Kind, string, number, string, string][]
            ).map(([type, name, users, label, tag]) => (
              <button
                key={type}
                type="button"
                onClick={() => onAdd(type, name, users)}
                className="flex min-h-11 items-center justify-between rounded-lg border border-white/10 bg-white/5 p-2.5 text-left text-xs font-medium transition-colors hover:bg-white/10"
              >
                <span>{label}</span>
                <span className="text-[10px] text-accent">{tag}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-white/10 pt-3 text-xs">
            <span className="text-gray-400">
              Total Active Zones: <span className="font-bold text-white">{layout.length}</span>
            </span>
            <button type="button" onClick={onReset} className="min-h-11 text-red-400 hover:underline">
              Reset Map
            </button>
          </div>
        </div>
      )}

      <div className="absolute bottom-6 left-6 z-50 flex flex-col gap-4">
        <div className="gl-glass-panel flex items-center gap-4 rounded-xl px-5 py-3">
          <div>
            <h2 className="font-semibold text-white">Global Headquarters</h2>
            <p className="text-xs text-gray-400">Architectural Floor Plan</p>
          </div>
          <div className="h-8 w-px bg-gray-700" />
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <span className="text-lg font-medium text-white">{Math.max(120, scene.placed)}</span>
            <span className="text-sm text-gray-400">online</span>
          </div>
        </div>
      </div>

      <div className="gl-glass-panel absolute bottom-6 right-6 z-50 flex flex-col overflow-hidden rounded-lg">
        <button
          type="button"
          onClick={() => setZoom((z) => clampZoom(z + 0.05))}
          aria-label="Zoom in"
          className="min-h-12 border-b border-white/10 p-3 transition-colors hover:bg-white/10"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(DEFAULT_ZOOM);
            setTrans({ x: 0, y: 0 });
          }}
          className="min-h-12 border-b border-white/10 p-3 text-xs font-bold text-gray-400 transition-colors hover:bg-white/10"
        >
          RESET
        </button>
        <button
          type="button"
          onClick={() => setZoom((z) => clampZoom(z - 0.05))}
          aria-label="Zoom out"
          className="min-h-12 p-3 transition-colors hover:bg-white/10"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      <div ref={viewportRef} className="gl-viewport">
        <div data-testid="scene" className="gl-iso-scene" style={sceneStyle}>
          {scene.nodes}
        </div>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- the page

export function LandingPage({ devAuth = false, returnTo, notice }: { devAuth?: boolean; returnTo?: string; notice?: string }) {
  const [view, setView] = useState<View>("home");
  const [adminOpen, setAdminOpen] = useState(false);
  const [layout, setLayout] = useState<Zone[]>(DEFAULT_LAYOUT);

  const go = (next: View) => (e?: React.SyntheticEvent) => {
    e?.preventDefault();
    setView(next);
  };

  function toggleAdmin() {
    if (view !== "workspace") {
      setView("workspace");
      setAdminOpen(true);
    } else {
      setAdminOpen((open) => !open);
    }
  }

  function addZone(type: Kind, name: string, targetUsers: number) {
    setLayout((current) => {
      const offset = current.length * 120;
      return [
        ...current,
        {
          id: `custom_${Date.now()}`,
          type,
          name,
          x: 300 + (offset % 1200),
          y: 1800 + Math.floor(offset / 1200) * 350,
          w: type === "desks" ? 700 : 450,
          h: 400,
          targetUsers,
        },
      ];
    });
  }

  return (
    <div className="gl-root flex h-screen flex-col font-sans antialiased">
      <nav
        aria-label="Main"
        className="sticky top-0 z-[100] flex h-[72px] shrink-0 items-center justify-between border-b border-white/10 bg-charcoal/80 px-6 backdrop-blur-md md:px-12"
      >
        <div className="flex items-center gap-8">
          <a href="#" onClick={go("home")} aria-label="workspace.video" className="flex items-center gap-3">
            <div className="h-4 w-4 rounded-full bg-accent" />
            <span className="text-xl font-bold tracking-tight text-white">
              workspace<span className="font-normal text-gray-400">.video</span>
            </span>
          </a>
          <div className="hidden items-center gap-6 text-sm font-medium text-gray-300 md:flex">
            <a href="#" onClick={go("workspace")} className="transition-colors hover:text-white">
              Spatial Map
            </a>
            <a href="#" onClick={go("meeting")} className="transition-colors hover:text-white">
              Instant Space
            </a>
            <a href="#" onClick={go("pricing")} className="transition-colors hover:text-white">
              Pricing
            </a>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={toggleAdmin}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-accent/40 bg-accent/20 px-4 py-2 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            Admin Builder
          </button>
          <a href="#" onClick={go("auth")} className="hidden text-sm font-medium text-gray-300 hover:text-white sm:block">
            Sign in
          </a>
          <a
            href="#"
            onClick={go("workspace")}
            className="whitespace-nowrap rounded-lg bg-white px-5 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-gray-200"
          >
            Launch Workspace
          </a>
        </div>
      </nav>

      {view === "home" && (
        <main className="gl-app-view flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-7xl flex-col items-center px-6 py-20 text-center md:py-32">
            <div className="mb-8 inline-flex animate-fade-in items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm text-gray-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              Now supporting up to 200 users per workspace with Admin Drag &amp; Drop Builder
            </div>

            <h1 className="mb-8 max-w-4xl animate-slide-up bg-gradient-to-br from-white to-gray-500 bg-clip-text text-5xl font-bold leading-tight tracking-tight text-transparent md:text-7xl">
              A lightweight spatial layer for remote work.
            </h1>

            <p className="mb-12 max-w-2xl animate-slide-up text-xl text-gray-400" style={{ animationDelay: "0.1s" }}>
              See where your team is, drop into focus desks, or jump into meeting rooms instantly. Admins can build custom spatial maps
              easily.
            </p>

            <div className="flex flex-wrap justify-center gap-4 animate-slide-up" style={{ animationDelay: "0.2s" }}>
              <button
                type="button"
                onClick={go("workspace")}
                className="rounded-xl bg-accent px-8 py-4 text-lg font-semibold text-charcoal shadow-lg shadow-accent/20 transition-colors hover:bg-accent-hover"
              >
                Explore the 200-User Map
              </button>
              <button
                type="button"
                onClick={toggleAdmin}
                className="rounded-xl border border-white/20 px-8 py-4 text-lg font-medium text-white transition-colors hover:bg-white/5"
              >
                Open Admin Builder
              </button>
            </div>

            <div id="start" className="mt-14 w-full scroll-mt-28">
              <SignInForm variant="hero" returnTo={returnTo} notice={notice} />
            </div>
          </div>
        </main>
      )}

      {view === "workspace" && (
        <MapScreen
          layout={layout}
          adminOpen={adminOpen}
          onCloseAdmin={() => setAdminOpen(false)}
          onAdd={addZone}
          onReset={() => setLayout(DEFAULT_LAYOUT)}
        />
      )}

      {view === "meeting" && (
        <main className="gl-app-view bg-[#0a0a0a]">
          <div className="flex h-full flex-1">
            <div className="flex flex-1 flex-col gap-4 p-6">
              <div className="flex items-center justify-between rounded-xl border border-white/5 bg-surface/50 p-4">
                <div>
                  <h2 className="text-xl font-bold">Design Studio - Sync</h2>
                  <p className="text-sm text-gray-400">Instant Space · 4 Participants</p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={go("workspace")}
                    className="min-h-11 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
                  >
                    Leave Space
                  </button>
                </div>
              </div>
              <div className="grid flex-1 grid-cols-2 gap-4">
                <div className="relative flex items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gray-800">
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-accent text-3xl font-bold text-charcoal">
                      Y
                    </div>
                    <p className="font-medium">You</p>
                  </div>
                </div>
                <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[url('https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&q=80&w=800')] bg-cover bg-center" />
              </div>
            </div>
          </div>
        </main>
      )}

      {view === "pricing" && (
        <main className="gl-app-view overflow-y-auto py-20">
          <div className="mx-auto max-w-7xl px-6 text-center">
            <h1 className="mb-4 text-4xl font-bold md:text-5xl">Simple, transparent pricing</h1>
            <p className="mb-12 text-lg text-gray-400">Bring your team together in a lightweight spatial environment.</p>
            <button
              type="button"
              onClick={go("workspace")}
              className="rounded-xl bg-accent px-8 py-4 text-lg font-semibold text-charcoal transition-colors hover:bg-accent-hover"
            >
              Get Started Free
            </button>
          </div>
        </main>
      )}

      {view === "auth" && (
        <main className="gl-app-view items-center justify-center py-10">
          <div className="gl-glass-panel w-full max-w-xl animate-fade-in rounded-2xl p-8 text-center">
            <div className="mx-auto mb-4 h-10 w-10 rounded-full bg-accent" />
            <h2 className="mb-6 text-2xl font-bold">Welcome back</h2>
            <SignInForm variant="hero" returnTo={returnTo} notice={notice} />
            {devAuth && (
              <div className="mx-auto mt-6 max-w-sm text-left">
                <DevSignInForm />
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
