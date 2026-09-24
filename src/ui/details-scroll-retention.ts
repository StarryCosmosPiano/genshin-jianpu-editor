/** Keep a scrolled panel still while a native <details> section collapses. */
export function retainDetailsScroll(root: HTMLElement, scroll: HTMLElement): () => void {
  const spacer = document.createElement("div");
  spacer.dataset.detailsScrollSpacer = "";
  spacer.setAttribute("aria-hidden", "true");
  spacer.style.cssText = "height:0;min-height:0;flex:0 0 auto;pointer-events:none;";
  let reserved = 0;
  let guardTop = 0;
  let retentionActive = false;
  let lastViewportHeight = scroll.clientHeight;
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

  const naturalContentEnd = (): number => {
    const connected = spacer.isConnected;
    if (!connected) {
      spacer.style.height = "0px";
      scroll.append(spacer);
    }
    // scrollHeight is never smaller than clientHeight, so it overstates the
    // real content length in a tall window. The spacer's start is the true
    // trailing edge, regardless of the spacer's current height.
    const end = spacer.getBoundingClientRect().top - scroll.getBoundingClientRect().top
      + scroll.scrollTop + (parseFloat(getComputedStyle(scroll).paddingBottom) || 0);
    if (!connected) spacer.remove();
    return end;
  };

  const beginToggle = (details: HTMLDetailsElement, toggle?: () => void): void => {
    const top = scroll.scrollTop;
    const wasOpen = details.open;
    const oldHeight = details.getBoundingClientRect().height;
    changing = true;
    // Reserve before the browser performs the summary's default toggle.
    if (wasOpen && top > 0) setReserved(reserved + oldHeight);
    toggle?.();
    requestAnimationFrame(() => {
      if (disposed) return;
      // A canceled click must leave the section and scroll area untouched.
      if (details.open === wasOpen) {
        setReserved(Math.max(0, reserved - (wasOpen && top > 0 ? oldHeight : 0)));
        changing = false;
        return;
      }
      // Measure the real page after the native toggle, then add only enough
      // space to keep the previous viewport position reachable.
      setReserved(Math.max(0, top + scroll.clientHeight - naturalContentEnd()));
      scroll.scrollTop = top;
      guardTop = scroll.scrollTop;
      retentionActive = true;
      lastViewportHeight = scroll.clientHeight;
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

  const onResize = (): void => {
    if (disposed || changing || !retentionActive) return;
    lastViewportHeight = scroll.clientHeight;
    // Shrinking the window exposes more real content and can make some or all
    // of the retained tail unnecessary. Growing it may require tail again,
    // even after a prior shrink had reduced the spacer to zero.
    setReserved(Math.max(0, guardTop + scroll.clientHeight - naturalContentEnd()));
    scroll.scrollTop = guardTop;
  };

  const onScroll = (): void => {
    if (changing) return;
    if (retentionActive && scroll.clientHeight !== lastViewportHeight) {
      // Browser scroll clamping may fire before ResizeObserver. Restore the
      // saved position before treating that event as a deliberate user scroll.
      onResize();
      return;
    }
    const top = scroll.scrollTop;
    if (reserved === 0) {
      if (retentionActive) guardTop = top;
      return;
    }
    if (top < guardTop) {
      // Upward scrolling pays back the temporary space one pixel at a time.
      setReserved(top <= 0 ? 0 : reserved - (guardTop - top));
      guardTop = scroll.scrollTop;
    } else if (top > guardTop) {
      // A shorter floating window or newly revealed content can put real
      // controls below the retained position. Only the synthetic tail is
      // off-limits; a fixed guardTop blocked all downward wheel movement.
      const realBottom = Math.max(0, scroll.scrollHeight - reserved - scroll.clientHeight);
      scroll.scrollTop = Math.min(top, Math.max(guardTop, realBottom));
      guardTop = scroll.scrollTop;
    }
  };

  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
  resizeObserver?.observe(scroll);

  root.addEventListener("click", onClick, true);
  root.addEventListener("keydown", onKeyDown, true);
  scroll.addEventListener("scroll", onScroll);
  return () => {
    disposed = true;
    root.removeEventListener("click", onClick, true);
    root.removeEventListener("keydown", onKeyDown, true);
    scroll.removeEventListener("scroll", onScroll);
    resizeObserver?.disconnect();
    spacer.remove();
  };
}
