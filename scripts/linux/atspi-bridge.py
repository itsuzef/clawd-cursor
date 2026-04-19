#!/usr/bin/env python3
"""
AT-SPI bridge — read-only first pass (Tranche 4b).

Wraps GNOME's AT-SPI D-Bus a11y API via gobject-introspection's Atspi
binding. Used by LinuxAdapter to answer getUiTree / findElements /
getFocusedElement when the host is a Linux box with at-spi2 running
(every modern GNOME / KDE session with accessibility enabled).

Contract: same JSON shape as scripts/ps-bridge.ps1 (Windows) and
scripts/mac/*.jxa (macOS) — one JSON blob to stdout, exit 0 on
success, exit 1 with {"error": "..."} on failure.

Commands:
    --cmd get-tree [--process-id N]
        Walk the a11y tree of the active window (or the given process
        when --process-id is set). Returns a flat list of elements.

    --cmd find [--name N] [--role R] [--process-id N]
        Find elements matching a name substring and/or role. Returns
        a flat list.

    --cmd focused
        Return the currently-focused a11y element (or null).

NOT IMPLEMENTED in this pass (stays at the LinuxAdapter level as a
{success:false} response):
    --cmd invoke (click/focus/set-value/expand/...) — action dispatch
        requires AT-SPI Action interface handling per-role. Follow-up.

Dependencies:
    python3 (3.6+) with:
      - python3-gi          (Debian/Ubuntu) or equivalent
      - gir1.2-atspi-2.0    (Debian/Ubuntu) or libatspi / atspi

Dependency probe runs on the Node side (`hasBinary('python3')` +
a `python3 -c "from gi.repository import Atspi"` check). When the
probe fails, the LinuxAdapter's a11y methods keep returning empty
gracefully — same behavior as before this bridge existed.

Safety: every AT-SPI call is wrapped in try/except so one bad
element (stale reference, permission denial, app process died)
doesn't take down the whole tree walk.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Optional

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi  # type: ignore[import-not-found]
except Exception as exc:
    sys.stdout.write(json.dumps({
        "error": "pyatspi/gi.repository.Atspi not available",
        "detail": str(exc),
        "hint": "apt-get install python3-gi gir1.2-atspi-2.0  (or distro equivalent)",
    }))
    sys.exit(1)


# ── Helpers ────────────────────────────────────────────────────────

MAX_TREE_DEPTH = 12
MAX_TREE_NODES = 800   # stop after this many elements to bound cost
INTERACTIVE_ROLES = {
    # Roles whose state/value the agent is most likely to care about.
    # Used to prefer these over structural containers when truncating.
    'push button', 'toggle button', 'check box', 'radio button',
    'menu item', 'check menu item', 'radio menu item',
    'link', 'hyperlink',
    'text', 'entry', 'password text', 'editable text', 'combo box',
    'list item', 'tree item', 'tab',
    'slider', 'spin button', 'scroll bar',
}


def safe(fn, default=None):
    """Call fn(), return default if it raises (stale ref, perm denied, etc.)."""
    try:
        return fn()
    except Exception:
        return default


def node_to_dict(acc: Any) -> Optional[dict]:
    """
    Convert an Atspi.Accessible node into the shared UiElement JSON shape.
    Returns None when the node lacks both a name AND a role — skip those.
    """
    if acc is None:
        return None
    name = safe(lambda: acc.get_name(), '') or ''
    role_name = safe(lambda: acc.get_role_name(), '') or ''
    if not name and not role_name:
        return None

    # Bounds via Component interface. Missing → zero rect.
    x, y, w, h = 0, 0, 0, 0
    try:
        comp = acc.get_component_iface()
        if comp:
            extents = comp.get_extents(Atspi.CoordType.SCREEN)
            x, y, w, h = extents.x, extents.y, extents.width, extents.height
    except Exception:
        pass

    # State flags
    focused = False
    enabled = True
    selected = False
    busy = False
    offscreen = False
    try:
        ss = acc.get_state_set()
        if ss is not None:
            focused  = ss.contains(Atspi.StateType.FOCUSED)
            enabled  = ss.contains(Atspi.StateType.ENABLED) and ss.contains(Atspi.StateType.SENSITIVE)
            selected = ss.contains(Atspi.StateType.SELECTED)
            busy     = ss.contains(Atspi.StateType.BUSY)
            offscreen = not ss.contains(Atspi.StateType.VISIBLE) or not ss.contains(Atspi.StateType.SHOWING)
    except Exception:
        pass

    # Value via Value or Text interface (whichever applies).
    value = None
    try:
        v = acc.get_value_iface()
        if v:
            value = str(v.get_current_value())
    except Exception:
        pass
    if value is None:
        try:
            txt = acc.get_text_iface()
            if txt:
                char_count = txt.get_character_count()
                if char_count > 0:
                    value = txt.get_text(0, min(char_count, 512))
        except Exception:
            pass

    # Process id
    pid = None
    try:
        pid = acc.get_process_id()
    except Exception:
        pass

    # AutomationId analogue — Atspi exposes "accessible-id" on some apps.
    automation_id = safe(lambda: acc.get_accessible_id(), None)

    return {
        "name": name,
        "controlType": role_name,
        "bounds": {"x": x, "y": y, "width": w, "height": h},
        "value": value,
        "enabled": enabled,
        "focused": focused,
        "selected": selected,
        "disabled": not enabled if enabled is not None else None,
        "busy": busy,
        "offscreen": offscreen,
        "processId": pid,
        "automationId": automation_id,
    }


def walk(acc: Any, out: list, depth: int = 0) -> None:
    """Depth-first flatten with caps on depth + total node count."""
    if acc is None: return
    if depth > MAX_TREE_DEPTH: return
    if len(out) > MAX_TREE_NODES: return

    node = node_to_dict(acc)
    if node is not None:
        out.append(node)

    try:
        child_count = acc.get_child_count()
    except Exception:
        return
    for i in range(child_count):
        try:
            child = acc.get_child_at_index(i)
        except Exception:
            continue
        walk(child, out, depth + 1)
        if len(out) > MAX_TREE_NODES: return


def active_application(process_id: Optional[int] = None) -> Optional[Any]:
    """Pick an Atspi.Accessible application root to walk.

    Without process_id: prefer the app whose name matches the active
    window title (heuristic — AT-SPI doesn't have a direct 'active app'
    concept). Fall back to the first app.
    """
    try:
        desktop = Atspi.get_desktop(0)
    except Exception:
        return None
    try:
        n = desktop.get_child_count()
    except Exception:
        return None

    # If caller supplied a pid, match on it.
    if process_id is not None:
        for i in range(n):
            app = safe(lambda i=i: desktop.get_child_at_index(i))
            if app is None:
                continue
            pid = safe(lambda app=app: app.get_process_id())
            if pid == process_id:
                return app
        return None

    # Heuristic: find the app that has a FOCUSED descendant.
    for i in range(n):
        app = safe(lambda i=i: desktop.get_child_at_index(i))
        if app is None:
            continue
        if has_focused_descendant(app):
            return app

    # Fallback: first app.
    return safe(lambda: desktop.get_child_at_index(0))


def has_focused_descendant(acc: Any, depth: int = 0) -> bool:
    if acc is None or depth > 6:
        return False
    try:
        ss = acc.get_state_set()
        if ss is not None and ss.contains(Atspi.StateType.FOCUSED):
            return True
    except Exception:
        pass
    try:
        n = acc.get_child_count()
    except Exception:
        return False
    for i in range(n):
        child = safe(lambda i=i: acc.get_child_at_index(i))
        if has_focused_descendant(child, depth + 1):
            return True
    return False


def focused_element() -> Optional[dict]:
    try:
        desktop = Atspi.get_desktop(0)
        n = desktop.get_child_count()
    except Exception:
        return None
    for i in range(n):
        app = safe(lambda i=i: desktop.get_child_at_index(i))
        if app is None: continue
        hit = _find_focused(app, 0)
        if hit is not None:
            return node_to_dict(hit)
    return None


def _find_focused(acc: Any, depth: int) -> Optional[Any]:
    if acc is None or depth > 12: return None
    try:
        ss = acc.get_state_set()
        if ss is not None and ss.contains(Atspi.StateType.FOCUSED):
            return acc
    except Exception:
        pass
    try:
        n = acc.get_child_count()
    except Exception:
        return None
    for i in range(n):
        hit = _find_focused(safe(lambda i=i: acc.get_child_at_index(i)), depth + 1)
        if hit is not None:
            return hit
    return None


# ── Command dispatch ─────────────────────────────────────────────

def cmd_get_tree(process_id: Optional[int]) -> dict:
    app = active_application(process_id)
    out: list = []
    if app is not None:
        walk(app, out)
    return {"elements": out, "truncated": len(out) > MAX_TREE_NODES}


def cmd_find(name: Optional[str], role: Optional[str], process_id: Optional[int]) -> dict:
    # Implement find as a post-filter over the tree walk — simpler than
    # deep-diving the collection interface and more predictable.
    tree = cmd_get_tree(process_id).get("elements", [])
    if name is None and role is None:
        return {"elements": tree}

    name_l = name.lower() if name else None
    role_l = role.lower() if role else None

    def matches(el: dict) -> bool:
        if name_l is not None:
            el_name = (el.get("name") or "").lower()
            if name_l not in el_name:
                return False
        if role_l is not None:
            el_role = (el.get("controlType") or "").lower()
            if role_l not in el_role:
                return False
        return True

    hits = [e for e in tree if matches(e)]
    return {"elements": hits}


def cmd_focused() -> dict:
    el = focused_element()
    return {"element": el}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--cmd', required=True, choices=['get-tree', 'find', 'focused'])
    p.add_argument('--name', default=None)
    p.add_argument('--role', default=None)
    p.add_argument('--process-id', type=int, default=None)
    args = p.parse_args()

    try:
        if args.cmd == 'get-tree':
            result = cmd_get_tree(args.process_id)
        elif args.cmd == 'find':
            result = cmd_find(args.name, args.role, args.process_id)
        elif args.cmd == 'focused':
            result = cmd_focused()
        else:
            result = {"error": f"unknown command: {args.cmd}"}
    except Exception as exc:
        result = {"error": str(exc)}
        sys.stdout.write(json.dumps(result))
        return 1

    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
