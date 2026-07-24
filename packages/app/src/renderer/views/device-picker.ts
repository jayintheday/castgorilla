/**
 * device-picker.ts — the sidebar "Play to" device list, its hint, and the count.
 *
 * The interesting problem here is that DISCOVERY NEVER FINISHES. mDNS is a
 * subscription, not a query: the engine pushes a device list whenever it changes
 * and there is no "that's all of them" event to wait for. So "no devices found"
 * is never a fact the app is told — it can only ever be an inference from
 * silence, and the app has to choose how long to listen before drawing it.
 *
 * Eight seconds, and never at startup. CLAUDE.md records that a real device in
 * screensaver/ambient state routinely misses a 5s discovery window and appears
 * on the retry, and warns that this "will read as 'the app doesn't see my TV'".
 * Flashing an amber "no devices found" for the first second of every launch
 * would be exactly that failure, manufactured by the UI rather than the network.
 *
 * The picker itself is an accessible LISTBOX (was an inline `<select>` before the
 * redesign): a `<ul role="listbox">` of `<li role="option">` rows, one per
 * device, with a roving tabindex (exactly one row is tab-reachable and the arrow
 * keys move it) and selection that follows focus. Click, Enter/Space, and the
 * arrow keys all resolve to `actions.selectDevice(id)`.
 */

import type { DiscoveredDevice } from '../../shared/engine-types.js';
import type { AppState } from '../store.js';
import type { AppActions, View } from './contracts.js';
import { el } from './dom.js';
import { deviceTypeLabel } from '../device-labels.js';

/**
 * How long to keep saying "searching" before admitting nothing has turned up.
 * Comfortably longer than the CLI's 5s window, which is documented as too short
 * for a sleeping device.
 */
export const DEVICE_SEARCH_GRACE_MS = 8000;

export type DeviceFieldState = 'searching' | 'found' | 'none';

/**
 * The `data-state` for `#device-field`.
 *
 * Any device at all wins immediately — a list that is still filling is still an
 * answer, and the list is then the thing to read. Otherwise it is "searching"
 * until the grace period expires. `none` is the only state that can flip BACK to
 * `found`, which is correct: devices keep arriving after we stopped promising
 * they would.
 */
export function deriveDeviceState(
  deviceCount: number,
  elapsedMs: number,
  graceMs: number = DEVICE_SEARCH_GRACE_MS,
): DeviceFieldState {
  if (deviceCount > 0) return 'found';
  return elapsedMs < graceMs ? 'searching' : 'none';
}

/**
 * How long a manual Refresh visibly "searches" for. A rescan can resolve almost
 * instantly (mock mode, or a network where every device is already known), and a
 * silent list-swap reads as "nothing happened" — the whole point of the button.
 * So we hold the searching affordance for a visible minimum regardless of how
 * fast the answer comes back.
 */
export const REFRESH_MIN_MS = 2500;

/**
 * The field state to actually present. A refresh in flight forces `searching`
 * even when devices are already listed: Refresh's job is visible feedback, not a
 * truthful discovery state, and a re-query genuinely might surface more. When no
 * refresh is in flight the derived state stands unchanged.
 */
export function effectiveDeviceState(
  derived: DeviceFieldState,
  refreshing: boolean,
): DeviceFieldState {
  return refreshing ? 'searching' : derived;
}

/**
 * The hint under the list. Hidden by CSS in the `found` state, but still set:
 * a string that is only ever read by a stylesheet rule is a string that rots.
 */
export function deviceHintText(state: DeviceFieldState, deviceCount: number): string {
  switch (state) {
    case 'searching':
      return 'Looking for devices on your network…';
    case 'found':
      return deviceCount === 1 ? '1 device found' : `${deviceCount} devices found`;
    case 'none':
      // Not "no devices found" — see the module header. Nothing has told us that.
      return 'Still looking — check the device is switched on and on this Wi-Fi network.';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** The sidebar footer count, in step with the field state so the two never disagree. */
export function deviceCountText(state: DeviceFieldState, deviceCount: number): string {
  switch (state) {
    case 'found':
      return deviceCount === 1 ? '1 device ready' : `${deviceCount} devices ready`;
    case 'searching':
      return 'Searching…';
    case 'none':
      // Terse, and — like the hint — does not claim discovery failed.
      return 'No devices yet';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/** A row's render model. Replaces the old `<option>` `OptionModel` (device rows are richer). */
export interface DeviceRowModel {
  id: string;
  /** The user's own name for the device. */
  name: string;
  /** A friendly "what kind" sub-label (see device-labels.ts). */
  type: string;
  /** Whether this is the currently-selected device. */
  selected: boolean;
}

/**
 * Build the row models for `#device-list`. An empty device list yields no rows
 * (unlike the old select, which always needed a placeholder option — here the
 * hint and the count carry the "still searching" message instead).
 */
export function buildDeviceRows(
  devices: readonly DiscoveredDevice[],
  selectedId: string | null,
): DeviceRowModel[] {
  return devices.map((d) => ({
    id: d.id,
    name: d.friendlyName,
    type: deviceTypeLabel(d),
    selected: d.id === selectedId,
  }));
}

export interface DevicePickerDeps {
  actions: AppActions;
  /**
   * Ask for a re-render. The grace period expiring is the one state change here
   * that no store event corresponds to, so this view owns a single timer and
   * pokes the render loop when it fires.
   */
  requestRender(): void;
  now?(): number;
}

export function mountDevicePicker(deps: DevicePickerDeps): View {
  const { actions, requestRender } = deps;
  const now = deps.now ?? ((): number => Date.now());

  const field = el<HTMLElement>('device-field');
  const list = el<HTMLUListElement>('device-list');
  const hint = el<HTMLParagraphElement>('device-hint');
  const count = el<HTMLElement>('device-count');
  const refresh = el<HTMLButtonElement>('device-refresh');
  const template = el<HTMLTemplateElement>('device-row-template');

  const startedAt = now();
  // +50ms so the render that runs on expiry sees an elapsed time that is
  // unambiguously past the grace period rather than exactly equal to it.
  setTimeout(requestRender, DEVICE_SEARCH_GRACE_MS + 50);

  /**
   * When Refresh was pressed, the timestamp until which the picker stays in its
   * visible "searching" state. 0 means no refresh is in flight. Mirrors the grace
   * timer above: a state change no store event corresponds to, so this view owns
   * the timer and pokes the render loop when the window closes.
   */
  let refreshingUntil = 0;

  refresh.addEventListener('click', () => {
    actions.refreshDevices();
    refreshingUntil = now() + REFRESH_MIN_MS;
    // Show the searching affordance now, and schedule the revert. +50ms so the
    // expiry render sees now() unambiguously past refreshingUntil (as the grace
    // timer does).
    requestRender();
    setTimeout(requestRender, REFRESH_MIN_MS + 50);
  });

  /** The `<li>` for each device id, and the current visual order of ids. */
  const rowById = new Map<string, HTMLElement>();
  let orderedIds: string[] = [];
  /** Signature of the last-built structure, so identical lists skip a rebuild. */
  let structureSig = '';

  /** Select a device and move keyboard focus onto its row (selection follows focus). */
  function select(id: string): void {
    actions.selectDevice(id);
    // selectDevice notifies synchronously → render() runs → tabindex is updated
    // on the same (unchanged) row nodes, so focusing after is safe.
    rowById.get(id)?.focus();
  }

  list.addEventListener('keydown', (event) => {
    if (orderedIds.length === 0) return;

    const active = document.activeElement;
    let index = orderedIds.findIndex((id) => rowById.get(id) === active);
    if (index === -1) {
      // Focus is in the list but not on a known row — anchor on the selected one.
      index = orderedIds.findIndex(
        (id) => rowById.get(id)?.getAttribute('aria-selected') === 'true',
      );
      if (index === -1) index = 0;
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        select(orderedIds[Math.min(index + 1, orderedIds.length - 1)]!);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        select(orderedIds[Math.max(index - 1, 0)]!);
        break;
      case 'Home':
        event.preventDefault();
        select(orderedIds[0]!);
        break;
      case 'End':
        event.preventDefault();
        select(orderedIds[orderedIds.length - 1]!);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        select(orderedIds[index]!);
        break;
      default:
        break;
    }
  });

  function rebuild(rows: readonly DeviceRowModel[]): void {
    rowById.clear();
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const node = template.content.firstElementChild;
      if (!node) throw new Error('#device-row-template is empty');
      const li = node.cloneNode(true) as HTMLElement;
      li.dataset.deviceId = row.id;
      const name = li.querySelector<HTMLElement>('.device-row__name');
      const type = li.querySelector<HTMLElement>('.device-row__type');
      if (name) name.textContent = row.name;
      if (type) type.textContent = row.type;
      li.addEventListener('click', () => select(row.id));
      frag.append(li);
      rowById.set(row.id, li);
    }
    list.replaceChildren(frag);
    orderedIds = rows.map((r) => r.id);
  }

  function applySelection(rows: readonly DeviceRowModel[]): void {
    // The roving tabindex goes on the selected row, else the first — so Tab always
    // lands somewhere sensible and exactly one row is tab-reachable.
    const rovingId = rows.find((r) => r.selected)?.id ?? rows[0]?.id ?? null;
    for (const row of rows) {
      const li = rowById.get(row.id);
      if (!li) continue;
      li.setAttribute('aria-selected', String(row.selected));
      li.tabIndex = row.id === rovingId ? 0 : -1;
    }
  }

  function render(state: Readonly<AppState>): void {
    const devices = state.devices;
    // A manual Refresh forces the searching affordance for a visible minimum, so
    // even an instant rescan reads as an action. Real device arrivals are NOT
    // suppressed — the rows below still rebuild from `state.devices` regardless;
    // only the field state / hint / count / spinner are pinned to searching.
    const refreshing = now() < refreshingUntil;
    const fieldState = effectiveDeviceState(
      deriveDeviceState(devices.length, now() - startedAt),
      refreshing,
    );

    field.dataset.state = fieldState;
    hint.textContent = deviceHintText(fieldState, devices.length);
    count.textContent = deviceCountText(fieldState, devices.length);
    refresh.classList.toggle('is-refreshing', refreshing);

    const rows = buildDeviceRows(devices, state.selectedDeviceId);
    // Rebuild the DOM only when the SET of rows (id/name/type) changes; a mere
    // selection change updates attributes in place, preserving focus mid-arrow-nav.
    const sig = rows.map((r) => `${r.id} ${r.name} ${r.type}`).join('');
    if (sig !== structureSig) {
      rebuild(rows);
      structureSig = sig;
    }
    applySelection(rows);
  }

  return { render };
}
