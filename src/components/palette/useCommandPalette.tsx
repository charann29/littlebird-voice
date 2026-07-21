/**
 * useCommandPalette — open-state context + the global ⌘K / Ctrl-K chord.
 *
 * The provider lives in AppShell; `open()` optionally seeds an initial query
 * (topbar searchbox / programmatic callers). The keydown listener is active
 * even while inputs are focused — ⌘K is a chord, so we preventDefault.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface CommandPaletteContextValue {
  isOpen: boolean;
  initialQuery: string;
  open: (initialQuery?: string) => void;
  close: () => void;
}

const CommandPaletteContext =
  createContext<CommandPaletteContextValue | null>(null);

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState("");

  const open = useCallback((query?: string) => {
    setInitialQuery(query ?? "");
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setIsOpen((prev) => {
          if (!prev) setInitialQuery("");
          return !prev;
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(
    () => ({ isOpen, initialQuery, open, close }),
    [isOpen, initialQuery, open, close],
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used within a CommandPaletteProvider",
    );
  }
  return ctx;
}
