export function BeaconMark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path
        className="beam"
        d="M16 12c5 1.4 8.5 2.2 11 2.2-2.4 1.5-6 3.8-11 3.8S7.4 15.7 5 14.2C7.5 14.2 11 13.4 16 12z"
      />
      <path className="lamp" d="M16 3.2 18.4 8h-4.8L16 3.2z" />
      <path className="tower" d="M13.2 9.2h5.6l1.3 13.2H11.9l1.3-13.2z" />
      <path
        className="base"
        d="M9.5 23.2h13v2.1a2.2 2.2 0 0 1-2.2 2.2h-8.6a2.2 2.2 0 0 1-2.2-2.2v-2.1z"
      />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconSend() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h11" />
      <path d="M12 6l6 6-6 6" />
    </svg>
  );
}

export function IconStop() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  );
}

export function IconMenu() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h10" />
    </svg>
  );
}
