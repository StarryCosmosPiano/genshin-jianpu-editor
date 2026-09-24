/** Keep a scrolled panel still while a native <details> section collapses. */
export function retainDetailsScroll(root: HTMLElement, scroll: HTMLElement): () => void {
  const spacer = document.createElement("div");
  spacer.dataset.detailsScrollSpacer = "";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText = "height:0;min-height:0;flex:0 0 auto;pointer-events:none;";
  let reserved = 0;
  let guardTop = 0;
  let changing = false;
  let disposed = false;

  const setReserved = (height: number): void => {
    reserved = Math.max(0, Math.ceil(height));
    if (reserved === 0) {
      spacer.remove();
    } else {
      // Keep the spacer outside the panel form: some forms have flex children
      // that would shrink by the same amount and cancel the reservation.
      if (!spacer.isConnected) scroll.append(spacer);
      spacer.style.height = `${reserved}px`;
    }
  };

  const beginToggle = (details: HTMLDetailsElement, toggle?: () => void): void => {
    const top = scroll.scrollTop;
    const wasOpen = details.open;
    const oldHeight = details.getBoundingClientRect().height;
    changing = true;
    // Reserve before the browser performs the summary's default toggle.
    if (wasOpen && top > 0) setReserved(reserved + oldHeight);
    toggle?.();
    queueMicrotask(() => {
      if (disposed) return;
      // A canceled click must leave the section and scroll area untouched.
      if (details.open === wasOpen) {
        setReserved(Math.max(0, reserved - (wasOpen && top > 0 ? oldHeight : 0)));
        changing = false;
        return;
      }
      // Measure the real page without the temporary tail, then add only the
      // space needed to keep the previous viewport position reachable.
      if (!spacer.isConnected) scroll.append(spacer);
      spacer.style.height = "0px";
      // scrollHeight never falls below clientHeight. Measuring the spacer's
      // actual start is essential when collapsing leaves less than one screen
      // of real content; otherwise the required tail is underestimated.
      const scrollTopEdge = scroll.getBoundingClientRect().top;
      const naturalEnd = spacer.getBoundingClientRect().top - scrollTopEdge
        + scroll.scrollTop + (parseFloat(getComputedStyle(scroll).paddingBottom) || 0);
      setReserved(Math.max(0, top + scroll.clientHeight - naturalEnd));
      scroll.scrollTop = top;
      guardTop = scroll.scrollTop;
      changing = false;
    });
  };

  const targetDetails = (target: EventTarget | null): HTMLDetailsElement | null => {
    if (!(target instanceof Element)) return null;
    const summary = target.closest("summary");
    const details = summary?.parentElement;
    return details instanceof HTMLDetailsElement && root.contains(details) ? details : null;
  };

  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0 || changing) return;
    const details = targetDetails(event.target);
    if (details) beginToggle(details);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (changing || (event.key !== "Enter" && event.key !== " ")) return;
    const details = targetDetails(event.target);
    if (!details) return;
    // Space may scroll a focused summary into view before its synthetic click.
    // Toggle here so the snapshot is taken before any browser scroll action.
    event.preventDefault();
    beginToggle(details, () => { details.open = !details.open; });
  };

  const onScroll = (): void => {
    if (changing || reserved === 0) return;
    const top = scroll.scrollTop;
    if (top < guardTop) {
      // Upward scrolling pays back the temporary space one pixel at a time.
      setReserved(top <= 0 ? 0 : reserved - (guardTop - top));
      guardTop = scroll.scrollTop;
    } else if (top > guardTop) {
      // Do not let wheel, touch, keyboard, or scrollbar input enter the tail.
      scroll.scrollTop = guardTop;
    }
  };

  root.addEventListener("click", onClick, true);
  root.addEventListener("keydown", onKeyDown, true);
  scroll.addEventListener("scroll", onScroll);
  return () => {
    disposed = true;
    root.removeEventListener("click", onClick, true);
    root.removeEventListener("keydown", onKeyDown, true);
    scroll.removeEventListener("scroll", onScroll);
    spacer.remove();
  };
}
