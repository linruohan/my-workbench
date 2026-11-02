import { useLayoutEffect, useState, type RefObject } from "react";

export type PortalMenuPos = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

export function placePortalMenu(
  trigger: HTMLElement,
  menu: HTMLElement,
  preferWidth?: number,
): PortalMenuPos {
  const rect = trigger.getBoundingClientRect();
  const gap = 6;
  const width = Math.min(
    Math.max(preferWidth ?? rect.width, rect.width, 160),
    window.innerWidth - 16,
  );
  const menuH = menu.offsetHeight || 220;
  const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
  const spaceAbove = rect.top - gap - 8;
  const openUp = spaceBelow < Math.min(menuH, 200) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(140, openUp ? spaceAbove : spaceBelow);
  const left = Math.min(
    Math.max(8, rect.left),
    window.innerWidth - width - 8,
  );
  const top = openUp
    ? Math.max(8, rect.top - gap - Math.min(menuH, maxHeight))
    : rect.bottom + gap;
  return { top, left, width, maxHeight };
}

export function usePortalMenuPos(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  preferWidth?: number,
): PortalMenuPos | null {
  const [pos, setPos] = useState<PortalMenuPos | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    let raf = 0;
    const update = () => {
      if (!triggerRef.current || !menuRef.current) return;
      setPos(placePortalMenu(triggerRef.current, menuRef.current, preferWidth));
    };
    update();
    raf = requestAnimationFrame(() => {
      update();
      raf = requestAnimationFrame(update);
    });
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, triggerRef, menuRef, preferWidth]);

  return pos;
}
