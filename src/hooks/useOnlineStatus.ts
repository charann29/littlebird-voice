import { useEffect, useState } from "react";

/**
 * Reactive network-status hook.
 *
 * NOTE: `navigator.onLine` is NOT authoritative — it only reports whether the
 * browser has a network interface, so it returns `true` behind captive portals
 * or when connected to a router with no upstream internet. Treat this value as
 * a UI hint (badge color, steer banners) only, never as a hard correctness gate
 * for whether a live request will actually succeed.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
